import { randomUUID } from "node:crypto";
import { assertTaskAutomationAllowed } from "../../services/tasks/control.ts";
import { queueInstruction, deliverInstructions } from "../../services/sessions/inbox.ts";

import type {
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeTurn,
  AcpSessionRecord,
} from "acpx/runtime";
import {
  createAcpRuntime,
  type AcpElicitationResponse,
  type AcpPermissionDecision,
  type AcpPermissionRequest,
  createAgentRegistry,
  createRuntimeStore,
} from "acpx/runtime";
import type {
  McpServer,
  SessionConfigOption,
  SessionNotification,
  ToolCallStatus,
} from "@agentclientprotocol/sdk";

import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import {
  getRepositoryConfig,
  resolveRepositoryForCwd,
} from "../../../../lib/config.ts";
import {
  appendRuntimeLifecycleEvent,
  attachRuntimeSession,
  beginRuntimeSession,
  findRuntimeSession,
  listRuntimeSessions,
  prepareRuntimeAgentSwitch,
  updateRuntimeSessionState,
} from "../../services/sessions/runtime-registry.ts";
import { resolveInitialSessionLabels } from "../../services/sessions/session-metadata.ts";
import type {
  AgentElicitationHandler,
  AgentPermissionInterceptor,
  AgentRuntimeEvent,
  AgentRuntimeMessage,
  AgentRuntimeSession,
  AgentRuntimeTurn,
  AgentRuntimeTurnResult,
  AgentSessionRuntime,
  EnsureAgentSessionInput,
} from "../../../../types/runtime/index.ts";

class AsyncPushQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function toolStatus(value: string | undefined): ToolCallStatus {
  if (
    value === "pending" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "failed"
  ) return value;
  return "in_progress";
}

function textFromUserMessage(message: unknown): string | null {
  if (!message || typeof message !== "object" || !("User" in message)) return null;
  const user = (message as { User?: { content?: unknown[] } }).User;
  const parts = (user?.content ?? []).flatMap((item) => {
    if (!item || typeof item !== "object" || !("Text" in item)) return [];
    const value = (item as { Text?: unknown }).Text;
    return typeof value === "string" ? [value] : [];
  });
  return parts.length ? parts.join("\n") : null;
}

function textFromAgentMessage(message: unknown): string | null {
  if (!message || typeof message !== "object" || !("Agent" in message)) return null;
  const agent = (message as { Agent?: { content?: unknown[] } }).Agent;
  const parts = (agent?.content ?? []).flatMap((item) => {
    if (!item || typeof item !== "object" || !("Text" in item)) return [];
    const value = (item as { Text?: unknown }).Text;
    return typeof value === "string" ? [value] : [];
  });
  return parts.length ? parts.join("\n") : null;
}

function configOptionsFromStatus(value: unknown): SessionConfigOption[] {
  if (!value || typeof value !== "object") return [];
  const details = (value as { details?: unknown }).details;
  if (!details || typeof details !== "object") return [];
  const options = (details as { configOptions?: unknown }).configOptions;
  return Array.isArray(options) ? (options as SessionConfigOption[]) : [];
}

export class AcpxSessionRuntime implements AgentSessionRuntime {
  private readonly store;
  private readonly runtimes = new Map<string, ReturnType<typeof createAcpRuntime>>();
  private readonly handles = new Map<string, AcpRuntimeHandle>();
  private readonly listeners = new Map<
    string,
    Set<(event: AgentRuntimeEvent) => void | Promise<void>>
  >();
  private readonly globalListeners = new Set<
    (event: AgentRuntimeEvent) => void | Promise<void>
  >();
  private readonly turnChains = new Map<string, Promise<void>>();
  private readonly activeTurns = new Map<string, AcpRuntimeTurn>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: ServerConfig,
    private readonly options: {
      onPermissionRequest?: AgentPermissionInterceptor;
      /** MCP servers every session's harness spawns (e.g. remote-agent's own tools). */
      mcpServers?: McpServer[];
    } = {},
  ) {
    this.store = createRuntimeStore({ stateDir: config.acpxStateDir });
  }

  /** Providers sanitize the environment of MCP children. Carry each
   * session's identity explicitly in its own MCP descriptor. */
  private runtimeFor(sessionId: string): ReturnType<typeof createAcpRuntime> {
    const existing = this.runtimes.get(sessionId);
    if (existing) return existing;
    const runtime = createAcpRuntime({
      cwd: this.config.installRoot,
      sessionStore: this.store,
      agentRegistry: createAgentRegistry({
        overrides: this.config.acpxAgentCommands,
      }),
      // Sessions run unattended; agents get their tool requests approved.
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
      elicitationModes: ["form", "url"],
      mcpServers: sessionMcpServers(sessionId, this.config, this.options.mcpServers ?? []),
      // Consulted before approve-all answers; undefined falls through to it.
      ...(this.options.onPermissionRequest
        ? {
            onPermissionRequest: (request, context) =>
              this.interceptPermissionRequest(request, context),
          }
        : {}),
    });
    this.runtimes.set(sessionId, runtime);
    return runtime;
  }

  private async interceptPermissionRequest(
    request: AcpPermissionRequest,
    context: { signal: AbortSignal },
  ): Promise<AcpPermissionDecision | undefined> {
    const interceptor = this.options.onPermissionRequest;
    if (!interceptor) return undefined;
    try {
      const sessionId = await this.sessionIdForAcpSession(request.sessionId);
      if (!sessionId) return undefined;
      // Interception is observational; a broken OR HANGING interceptor must
      // never block the turn — after the cap the runtime's policy answers
      // and whatever the interceptor was persisting finishes in the
      // background (or fails and logs on its own).
      const decision = await Promise.race([
        interceptor({ sessionId, raw: request.raw }, context),
        new Promise<undefined>((resolve) => {
          const timer = setTimeout(() => resolve(undefined), 60_000);
          context.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve(undefined);
          });
        }),
      ]);
      return decision ? { outcome: decision.outcome } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Maps the agent's ACP session ID (what permission requests carry) back
      to the Remote Agent session ID: live handles first, database second. */
  private async sessionIdForAcpSession(
    acpSessionId: string,
  ): Promise<string | null> {
    for (const [sessionId, handle] of this.handles) {
      if (handle.agentSessionId === acpSessionId) return sessionId;
    }
    const row = await this.prisma.runtimeSession.findFirst({
      where: {
        OR: [
          { agentSessionId: acpSessionId },
          { acpxSessionId: acpSessionId },
          { id: acpSessionId },
        ],
        status: { not: "closed" },
      },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  async ensureSession(
    input: EnsureAgentSessionInput,
  ): Promise<AgentRuntimeSession> {
    const repository = input.repositoryId
      ? getRepositoryConfig(this.config, input.repositoryId)
      : resolveRepositoryForCwd(this.config, input.cwd);
    const cwdRepository = resolveRepositoryForCwd(this.config, input.cwd);
    if (cwdRepository.id !== repository.id) {
      throw new Error(
        `cwd resolves to repository ${cwdRepository.id}, not ${repository.id}`,
      );
    }
    const normalizedInput: EnsureAgentSessionInput = {
      ...input,
      repositoryId: repository.id,
      machineId: input.machineId ?? input.executionTarget ?? this.config.machine,
    };
    const row = await beginRuntimeSession(this.prisma, normalizedInput, {
      labels: resolveInitialSessionLabels(repository, input.labels),
    });
    try {
      const task = await this.prisma.remoteTask.findUnique({ where: { worktreePath: row.cwd } });
      const handle = await this.runtimeFor(row.id).ensureSession({
        sessionKey: row.id,
        agent: input.agent,
        mode: "persistent",
        cwd: row.cwd,
        sessionOptions: {
          ...(input.model ? { model: input.model } : {}),
          ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
          env: sessionEnvironment(row.id, this.config, { ...input.agentEnv,
            ...(task ? { REMOTE_AGENT_TASK_ID: task.id, ...(task.pinnedToolingRoot ? { REMOTE_AGENT_TOOLING_ROOT: task.pinnedToolingRoot } : {}) } : {}),
          }),
        },
      });
      this.handles.set(row.id, handle);
      const runtimeStatus = await this.runtimeFor(row.id).getStatus({ handle });
      return await attachRuntimeSession(this.prisma, {
        id: row.id,
        acpxRecordId: handle.acpxRecordId ?? row.acpxRecordId ?? row.id,
        acpxSessionId: handle.backendSessionId,
        agentSessionId: handle.agentSessionId,
        configOptions: configOptionsFromStatus(runtimeStatus),
      });
    } catch (error) {
      await updateRuntimeSessionState(this.prisma, row.id, {
        status: "error",
        recoveryDetail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  getSession(sessionId: string): Promise<AgentRuntimeSession | null> {
    return findRuntimeSession(this.prisma, sessionId);
  }

  listSessions(
    input: { cwd?: string; repositoryId?: string; includeClosed?: boolean } = {},
  ): Promise<AgentRuntimeSession[]> {
    const repositoryId = input.repositoryId ?? (
      input.cwd ? resolveRepositoryForCwd(this.config, input.cwd).id : undefined
    );
    return listRuntimeSessions(this.prisma, {
      ...(repositoryId ? { repositoryId } : {}),
      ...(input.includeClosed === undefined
        ? {}
        : { includeClosed: input.includeClosed }),
    });
  }

  async history(sessionId: string): Promise<AgentRuntimeMessage[]> {
    const session = await this.requireSession(sessionId);
    const record = await this.loadRecord(session);
    if (!record) return [];
    const messages: AgentRuntimeMessage[] = [];
    for (const message of record.messages) {
      const user = textFromUserMessage(message);
      if (user) messages.push({ role: "user", text: user });
      const agent = textFromAgentMessage(message);
      if (agent) messages.push({ role: "agent", text: agent });
    }
    return messages;
  }

  startTurn(input: {
    sessionId: string;
    text: string;
    requestId?: string;
    mode?: "prompt" | "steer";
    signal?: AbortSignal;
    onElicitation?: AgentElicitationHandler;
  }): AgentRuntimeTurn {
    const requestId = input.requestId ?? randomUUID();
    const queue = new AsyncPushQueue<AgentRuntimeEvent>();
    const completion = deferred<AgentRuntimeTurnResult>();
    let cancelled = false;
    let current: AcpRuntimeTurn | null = null;

    const previous = this.turnChains.get(input.sessionId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        if (cancelled || input.signal?.aborted) {
          completion.resolve({ status: "cancelled", stopReason: "cancelled" });
          queue.close();
          return;
        }
        const session = await this.requireSession(input.sessionId);
        await assertTaskAutomationAllowed(this.prisma, session.cwd);
        const handle = await this.handleFor(session);
        await updateRuntimeSessionState(this.prisma, session.id, {
          status: "active",
          recoveryDetail: null,
        });
        await this.emitLifecycle({
          kind: "turn",
          id: `${requestId}:started`,
          sessionId: session.id,
          requestId,
          createdAt: Date.now(),
          phase: "started",
        });
        await assertTaskAutomationAllowed(this.prisma, session.cwd);
        current = this.runtimeFor(session.id).startTurn({
          handle,
          text: input.text,
          mode: input.mode ?? "prompt",
          requestId,
          signal: input.signal,
          // Planning questions: forwarded to the attached ACP client when a
          // handler is provided; otherwise acpx resolves non-interactively.
          // The SDK response allows open-ended actions; acpx accepts only
          // accept/decline/cancel, so anything else degrades to cancel.
          ...(input.onElicitation
            ? {
                onElicitation: async (request, context): Promise<AcpElicitationResponse> => {
                  const response = await input.onElicitation!(request, {
                    signal: context.signal,
                  });
                  if (response.action === "accept") {
                    return {
                      action: "accept",
                      content: (response.content ?? null) as Extract<AcpElicitationResponse, { action: "accept" }>["content"],
                    };
                  }
                  if (response.action === "decline") return { action: "decline" };
                  return { action: "cancel" };
                },
              }
            : {}),
        });
        this.activeTurns.set(session.id, current);
        let index = 0;
        try {
          for await (const event of current.events) {
            for (const update of await this.toAcpUpdates(session.id, handle, event)) {
              const projected: AgentRuntimeEvent = {
                kind: "update",
                id: `${requestId}:${index++}`,
                sessionId: session.id,
                requestId,
                createdAt: Date.now(),
                update,
              };
              queue.push(projected);
              await this.emit(projected);
            }
          }
          const result = await current.result;
          if (result.status === "failed") {
            await updateRuntimeSessionState(this.prisma, session.id, {
              status: "error",
              recoveryDetail: result.error.message,
            });
            completion.resolve({
              status: "failed",
              error: result.error.message,
            });
            await this.emitLifecycle({
              kind: "turn",
              id: `${requestId}:failed`,
              sessionId: session.id,
              requestId,
              createdAt: Date.now(),
              phase: "failed",
              error: result.error.message,
            });
          } else {
            await this.refreshSessionState(session.id, handle);
            completion.resolve({
              status: result.status,
              ...(result.stopReason ? { stopReason: result.stopReason } : {}),
            });
            await this.emitLifecycle({
              kind: "turn",
              id: `${requestId}:${result.status}`,
              sessionId: session.id,
              requestId,
              createdAt: Date.now(),
              phase: result.status,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await updateRuntimeSessionState(this.prisma, session.id, {
            status: "error",
            recoveryDetail: message,
          });
          completion.resolve({ status: "failed", error: message });
          await this.emitLifecycle({
            kind: "turn",
            id: `${requestId}:failed`,
            sessionId: session.id,
            requestId,
            createdAt: Date.now(),
            phase: "failed",
            error: message,
          });
        } finally {
          if (this.activeTurns.get(session.id) === current) {
            this.activeTurns.delete(session.id);
          }
          queue.close();
        }
      });

    // Setup and control checks can fail before a provider turn exists. They
    // must settle the public result too, otherwise ACP clients hang forever.
    const chained = run.catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      completion.resolve({ status: "failed", error: message });
      queue.close();
      await updateRuntimeSessionState(this.prisma, input.sessionId, {
        status: "error", recoveryDetail: message,
      }).catch(() => undefined);
    }).finally(() => {
      if (this.turnChains.get(input.sessionId) === chained) {
        this.turnChains.delete(input.sessionId);
      }
    });
    this.turnChains.set(input.sessionId, chained);

    return {
      requestId,
      events: queue,
      result: completion.promise,
      cancel: async (reason?: string) => {
        cancelled = true;
        if (current) await current.cancel({ reason });
      },
    };
  }

  async enqueue(input: {
    sessionId: string;
    text: string;
    requestId?: string;
  }): Promise<string> {
    const session = await this.requireSession(input.sessionId);
    if (session.status === "closed") throw new Error("Session is closed");
    const receipt = await queueInstruction(this.prisma, input);
    void deliverInstructions(this.prisma, this).catch(() => undefined);
    return receipt.id;
  }

  async setMode(sessionId: string, mode: string): Promise<void> {
    const session = await this.requireSession(sessionId);
    const handle = await this.handleFor(session);
    await this.runtimeFor(sessionId).setMode({ handle, mode });
    await this.refreshSessionState(session.id, handle);
  }

  async setConfigOption(
    sessionId: string,
    key: string,
    value: string,
  ): Promise<SessionConfigOption[]> {
    const session = await this.requireSession(sessionId);
    const handle = await this.handleFor(session);
    const response = await this.runtimeFor(sessionId).setConfigOption({ handle, key, value });
    await updateRuntimeSessionState(this.prisma, session.id, {
      status: "idle",
      configOptions: response.configOptions,
      recoveryDetail: null,
    });
    return response.configOptions;
  }

  async switchAgent(
    sessionId: string,
    agent: "codex" | "claude",
  ): Promise<AgentRuntimeSession> {
    const session = await this.requireSession(sessionId);
    if (session.agent === agent) return session;
    if (this.activeTurns.has(sessionId)) {
      throw new Error("cannot switch agent while a turn is active");
    }
    const transcript = (await this.history(sessionId))
      .map((message) => `${message.role === "user" ? "User" : "Agent"}: ${message.text}`)
      .join("\n\n")
      .slice(-24_000);
    const oldHandle = await this.handleFor(session);
    const priorEnvironment = (await this.loadRecord(session))?.acpx?.session_options?.env;
    await this.runtimeFor(sessionId).close({
      handle: oldHandle,
      reason: `Switching Remote Agent session to ${agent}`,
    });
    this.handles.delete(sessionId);
    const switched = await prepareRuntimeAgentSwitch(this.prisma, {
      id: sessionId,
      agent,
    });
    try {
      const handle = await this.runtimeFor(sessionId).ensureSession({
        sessionKey: switched.id,
        agent,
        mode: "persistent",
        cwd: switched.cwd,
        sessionOptions: { env: sessionEnvironment(sessionId, this.config, priorEnvironment),
          ...(transcript ? {
              systemPrompt:
                "Continue the existing Remote Agent conversation summarized below. Preserve its context and wait for the user's next request.\n\n" +
                transcript,
            } : {}),
        },
      });
      this.handles.set(switched.id, handle);
      const status = await this.runtimeFor(sessionId).getStatus({ handle });
      return await attachRuntimeSession(this.prisma, {
        id: switched.id,
        acpxRecordId: handle.acpxRecordId ?? switched.id,
        acpxSessionId: handle.backendSessionId,
        agentSessionId: handle.agentSessionId,
        configOptions: configOptionsFromStatus(status),
      });
    } catch (error) {
      await updateRuntimeSessionState(this.prisma, switched.id, {
        status: "error",
        recoveryDetail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async cancel(sessionId: string, reason?: string): Promise<void> {
    const active = this.activeTurns.get(sessionId);
    if (active) {
      await active.cancel({ reason });
      return;
    }
    const session = await this.requireSession(sessionId);
    const handle = await this.handleFor(session);
    await this.runtimeFor(sessionId).cancel({ handle, reason });
  }

  async close(sessionId: string, reason: string): Promise<void> {
    const session = await this.requireSession(sessionId);
    const handle = await this.handleFor(session);
    await this.runtimeFor(sessionId).close({ handle, reason });
    await updateRuntimeSessionState(this.prisma, session.id, {
      status: "closed",
      closedAt: new Date(),
      recoveryDetail: null,
    });
    this.handles.delete(session.id);
    this.runtimes.delete(session.id);
  }

  async output(sessionId: string): Promise<string | null> {
    const messages = await this.history(sessionId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "agent") return message.text;
    }
    return null;
  }

  subscribe(
    sessionId: string,
    listener: (event: AgentRuntimeEvent) => void | Promise<void>,
  ): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(sessionId);
    };
  }

  subscribeAll(
    listener: (event: AgentRuntimeEvent) => void | Promise<void>,
  ): () => void {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.activeTurns.values()].map((turn) =>
        turn.cancel({ reason: "Remote Agent shutting down" }),
      ),
    );
  }

  private async requireSession(sessionId: string): Promise<AgentRuntimeSession> {
    const session = await findRuntimeSession(this.prisma, sessionId);
    if (!session) throw new Error(`runtime session not found: ${sessionId}`);
    if (session.status === "closed") {
      throw new Error(`runtime session is closed: ${sessionId}`);
    }
    return session;
  }

  private async handleFor(session: AgentRuntimeSession): Promise<AcpRuntimeHandle> {
    const existing = this.handles.get(session.id);
    if (existing) return existing;
    const handle = await this.runtimeFor(session.id).ensureSession({
      sessionKey: session.id,
      agent: session.agent,
      mode: "persistent",
      cwd: session.cwd,
    });
    this.handles.set(session.id, handle);
    await attachRuntimeSession(this.prisma, {
      id: session.id,
      acpxRecordId: handle.acpxRecordId ?? session.acpxRecordId ?? session.id,
      acpxSessionId: handle.backendSessionId,
      agentSessionId: handle.agentSessionId,
      configOptions: session.configOptions,
    });
    return handle;
  }

  private async loadRecord(
    session: AgentRuntimeSession,
  ): Promise<AcpSessionRecord | undefined> {
    if (!session.acpxRecordId) return undefined;
    return await this.store.load(session.acpxRecordId);
  }

  private async refreshSessionState(
    sessionId: string,
    handle: AcpRuntimeHandle,
  ): Promise<void> {
    const status = await this.runtimeFor(sessionId).getStatus({ handle });
    await updateRuntimeSessionState(this.prisma, sessionId, {
      status: "idle",
      configOptions: configOptionsFromStatus(status),
      recoveryDetail: null,
      ...(status.agentSessionId
        ? { agentSessionId: status.agentSessionId }
        : {}),
    });
  }

  private async toAcpUpdates(
    sessionId: string,
    handle: AcpRuntimeHandle,
    event: AcpRuntimeEvent,
  ): Promise<SessionNotification["update"][]> {
    if (event.type === "text_delta") {
      return [{
        sessionUpdate:
          event.stream === "thought"
            ? "agent_thought_chunk"
            : "agent_message_chunk",
        content: { type: "text", text: event.text },
        ...(event.messageId ? { messageId: event.messageId } : {}),
      }];
    }
    if (event.type === "tool_call") {
      if (event.tag === "tool_call_update") {
        return [{
          sessionUpdate: "tool_call_update",
          toolCallId: event.toolCallId ?? `${sessionId}:tool`,
          status: toolStatus(event.status),
          ...(event.title ? { title: event.title } : {}),
          ...(event.kind ? { kind: event.kind } : {}),
          ...(event.rawInput !== undefined ? { rawInput: event.rawInput } : {}),
          ...(event.rawOutput !== undefined ? { rawOutput: event.rawOutput } : {}),
          ...(event.content ? { content: event.content } : {}),
          ...(event.locations ? { locations: event.locations } : {}),
        }];
      }
      return [{
        sessionUpdate: "tool_call",
        toolCallId: event.toolCallId ?? `${sessionId}:tool`,
        title: event.title ?? (event.text || "Tool call"),
        status: toolStatus(event.status),
        ...(event.kind ? { kind: event.kind } : {}),
        ...(event.rawInput !== undefined ? { rawInput: event.rawInput } : {}),
        ...(event.rawOutput !== undefined ? { rawOutput: event.rawOutput } : {}),
        ...(event.content ? { content: event.content } : {}),
        ...(event.locations ? { locations: event.locations } : {}),
      }];
    }
    if (event.type !== "status") return [];
    if (event.tag === "usage_update" && event.used != null && event.size != null) {
      const usage = {
        used: event.used,
        size: event.size,
        ...(event.cost?.amount != null && event.cost.currency
          ? {
              cost: {
                amount: event.cost.amount,
                currency: event.cost.currency,
              },
            }
          : {}),
      };
      await updateRuntimeSessionState(this.prisma, sessionId, { usage });
      return [{ sessionUpdate: "usage_update", ...usage }];
    }
    if (event.tag === "config_option_update") {
      const status = await this.runtimeFor(sessionId).getStatus({ handle });
      const configOptions = configOptionsFromStatus(status);
      await updateRuntimeSessionState(this.prisma, sessionId, { configOptions });
      return [{ sessionUpdate: "config_option_update", configOptions }];
    }
    if (event.tag === "available_commands_update" && event.availableCommands) {
      return [{
        sessionUpdate: "available_commands_update",
        availableCommands: event.availableCommands.map((command) => ({
          name: command.name,
          description: command.description ?? "",
          input: command.hasInput ? { hint: "arguments" } : null,
        })),
      }];
    }
    if (event.tag === "current_mode_update") {
      const record = await this.store.load(handle.acpxRecordId ?? handle.sessionKey);
      const currentModeId = record?.acpx?.current_mode_id;
      return currentModeId
        ? [{ sessionUpdate: "current_mode_update", currentModeId }]
        : [];
    }
    return [];
  }

  private async emit(event: AgentRuntimeEvent): Promise<void> {
    const listeners = [
      ...(this.listeners.get(event.sessionId) ?? []),
      ...this.globalListeners,
    ];
    await Promise.all(listeners.map((listener) => listener(event)));
  }

  private async emitLifecycle(
    event: Omit<Extract<AgentRuntimeEvent, { kind: "turn" }>, "sequence">,
  ): Promise<void> {
    await this.emit(await appendRuntimeLifecycleEvent(this.prisma, event));
  }
}

/** Server-owned facts about the session itself, injected into the harness
    process so the remote-agent MCP server (a child of it) knows which
    session it serves and where the control socket is. */
export function sessionEnvironment(
  sessionId: string,
  config: Pick<ServerConfig, "controlIpcPath">,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    ...extra,
    REMOTE_AGENT_SESSION_ID: sessionId,
    REMOTE_AGENT_SOCKET: config.controlIpcPath,
  };
}

export function sessionMcpServers(sessionId: string, config: Pick<ServerConfig, "controlIpcPath">, servers: McpServer[]): McpServer[] {
  return servers.map((server) => {
    if (server.name !== "remote-agent" || !("command" in server)) return server;
    const env = sessionEnvironment(sessionId, config, Object.fromEntries(server.env.map(({ name, value }) => [name, value])));
    return { ...server, env: Object.entries(env).map(([name, value]) => ({ name, value })) };
  });
}

export function createAcpxSessionRuntime(
  prisma: PrismaClient,
  config: ServerConfig,
  options: { onPermissionRequest?: AgentPermissionInterceptor; mcpServers?: McpServer[] } = {},
): AgentSessionRuntime {
  return new AcpxSessionRuntime(prisma, config, options);
}
