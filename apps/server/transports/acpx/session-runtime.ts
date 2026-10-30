import { cleanupExecutionDirectory, CleanupTransportBlockedError } from "../../services/tasks/cleanup-transport.ts";
import { assertRequestActive } from "../../request-lifetime.ts";
import { randomUUID } from "node:crypto";
import { assertTaskOpen } from "../../services/tasks/task-state.ts";
import { queueInstruction, deliverInstructions } from "../../services/sessions/inbox.ts";
import { TurnCapacity } from "../../services/sessions/turn-capacity.ts";
import { recordSourceLifecycle } from "../../services/sessions/source-messages.ts";

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

function assertProviderStopped(record: AcpSessionRecord, activeSince?: Date): void {
  // acpx records the actual ACP child PID from its agent lifecycle snapshot.
  // Only ESRCH proves absence; permission errors and PID reuse fail closed.
  if (record.pid !== undefined) {
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0) throw new Error("Provider PID is invalid; cannot prove the writer stopped");
    try { process.kill(record.pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw new Error("Provider process liveness could not be verified; recovery is blocked");
    }
    throw new Error("Provider process is still alive; recovery will not reset a possible writer");
  }
  const exited = Date.parse(record.lastAgentExitAt ?? "");
  const started = Date.parse(record.agentStartedAt ?? "");
  const prompted = Date.parse(record.lastPromptAt ?? "");
  if (!Number.isFinite(exited) || !Number.isFinite(started) || !Number.isFinite(prompted) || exited < started || exited < prompted || (activeSince && exited < activeSince.getTime())) {
    throw new Error("Provider PID or confirmed exit evidence is unavailable; recovery cannot prove it stopped");
  }
}

export class AcpxSessionRuntime implements AgentSessionRuntime {
  private readonly store;
  private readonly runtimes = new Map<string, ReturnType<typeof createAcpRuntime>>();
  private readonly executionDirectories = new Map<string, { original: string; execution: string }>();
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
  private readonly waitingTurns = new Map<string, Set<AbortController>>();
  private readonly recoveringSessions = new Set<string>();
  private readonly releasingSessions = new Set<string>();
  private readonly capacity: TurnCapacity;

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
    this.capacity = new TurnCapacity(config.maxConcurrentTurns);
  }

  /** Providers sanitize the environment of MCP children. Carry each
   * session's identity explicitly in its own MCP descriptor. */
  private runtimeFor(sessionId: string): ReturnType<typeof createAcpRuntime> {
    const existing = this.runtimes.get(sessionId);
    if (existing) return existing;
    const runtime = createAcpRuntime({
      cwd: this.config.installRoot,
      // Logical/provider records retain the original cwd and complete history.
      // Only this connection's supported session/load request sees cleanup cwd.
      sessionStore: {
        load: async id => {
          const record = await this.store.load(id), context = this.executionDirectories.get(sessionId);
          if (!record || !context) return record;
          if (record.cwd !== context.original) throw new Error("Provider original cwd changed");
          return { ...record, cwd: context.execution };
        },
        save: async record => {
          const context = this.executionDirectories.get(sessionId);
          if (context && record.cwd !== context.execution) throw new Error("Provider cleanup cwd changed");
          await this.store.save(context ? { ...record, cwd: context.original } : record);
        },
      },
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
      if (this.recoveringSessions.has(row.id)) throw new Error("Session transport transition is in progress");
      await cleanupExecutionDirectory({ prisma: this.prisma, config: this.config, sessionId: row.id });
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
      if (!(error instanceof CleanupTransportBlockedError)) await updateRuntimeSessionState(this.prisma, row.id, {
        status: "error",
        recoveryDetail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  getSession(sessionId: string): Promise<AgentRuntimeSession | null> {
    return findRuntimeSession(this.prisma, sessionId);
  }

  observeSessionActivity(sessionId: string) {
    const active = this.activeTurns.get(sessionId);
    const state = active ? "executing" as const
      : this.turnChains.has(sessionId) || this.waitingTurns.get(sessionId)?.size ? "queued" as const : "unknown" as const;
    return { state, observedAt: Date.now(), ...(active ? { requestId: active.requestId } : {}) };
  }

  async reconcileInterruptedSession(sessionId: string): Promise<AgentRuntimeSession> {
    if (this.recoveringSessions.has(sessionId) || this.turnChains.has(sessionId) || this.activeTurns.has(sessionId) || this.waitingTurns.get(sessionId)?.size) {
      throw new Error("Session still has local work in flight; wait for it to stop before resolving");
    }
    this.recoveringSessions.add(sessionId);
    try {
      const session = await this.prisma.runtimeSession.findUniqueOrThrow({ where: { id: sessionId } });
      if (session.status === "closed" || session.status === "provisioning") throw new Error("Session is closed or still provisioning");
      if (!session.acpxRecordId) throw new Error("Provider process identity is unavailable; recovery cannot prove it stopped");
      const record = await this.store.load(session.acpxRecordId);
      if (!record || record.acpxRecordId !== session.acpxRecordId || record.cwd !== session.cwd || record.acpSessionId !== session.acpxSessionId) {
        throw new Error("Provider record identity changed or is unavailable; inspect the session before recovery");
      }
      assertProviderStopped(record, session.status === "active" ? session.updatedAt : undefined);
      // getStatus() reads persisted data too. Check the actual agent PID and
      // reject changing records instead of treating a stored status as liveness.
      const current = await this.store.load(session.acpxRecordId);
      if (JSON.stringify(current) !== JSON.stringify(record)) throw new Error("Provider record changed during recovery; inspect and retry");
      if (session.status === "active") {
        const changed = await this.prisma.runtimeSession.updateMany({
          where: { id: sessionId, status: "active", updatedAt: session.updatedAt },
          data: { status: "idle", recoveryDetail: "Provider process confirmed stopped during explicit instruction reconciliation; prior outcome remains unresolved until recorded." },
        });
        if (!changed.count) throw new Error("Session changed during recovery; inspect and retry");
      }
      return await this.requireSession(sessionId);
    } finally { this.recoveringSessions.delete(sessionId); }
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
    beforeStart?: () => Promise<boolean>;
    onElicitation?: AgentElicitationHandler;
  }): AgentRuntimeTurn {
    if (this.recoveringSessions.has(input.sessionId)) throw new Error("Session is being reconciled; retry after recovery finishes");
    const requestId = input.requestId ?? randomUUID();
    const queue = new AsyncPushQueue<AgentRuntimeEvent>();
    const completion = deferred<AgentRuntimeTurnResult>();
    let cancelled = false;
    let current: AcpRuntimeTurn | null = null;
    let releaseCapacity: (() => void) | undefined;
    const waiting = new AbortController();
    const waitingForSession = this.waitingTurns.get(input.sessionId) ?? new Set<AbortController>();
    waitingForSession.add(waiting);
    this.waitingTurns.set(input.sessionId, waitingForSession);
    const signal = input.signal ? AbortSignal.any([input.signal, waiting.signal]) : waiting.signal;

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
        await assertTaskOpen(this.prisma, session.cwd);
        if (this.capacity.full) {
          queue.push({ kind: "update", id: `${requestId}:queued`, sessionId: session.id, requestId, createdAt: Date.now(), update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Queued — waiting for an available agent slot on this machine.\n" } } });
        }
        releaseCapacity = await this.capacity.acquire(signal);
        if (cancelled || signal.aborted) throw new Error("Waiting turn cancelled");
        await this.requireSession(input.sessionId);
        await assertTaskOpen(this.prisma, session.cwd);
        if (signal.aborted) throw new Error("Waiting turn cancelled");
        await assertTaskOpen(this.prisma, session.cwd);
        if (input.beforeStart && !(await input.beforeStart())) {
          completion.resolve({ status: "cancelled", stopReason: "instruction-not-claimed" });
          queue.close();
          return;
        }
        const executionCwd = await cleanupExecutionDirectory({ prisma: this.prisma, config: this.config, sessionId: session.id, requestId });
        const handle = await this.handleFor(session, executionCwd);
        if (signal.aborted) throw new Error("Waiting turn cancelled");
        await updateRuntimeSessionState(this.prisma, session.id, {
          status: "active",
          recoveryDetail: null,
        });
        await assertTaskOpen(this.prisma, session.cwd);
        current = this.runtimeFor(session.id).startTurn({
          handle,
          text: input.text,
          mode: input.mode ?? "prompt",
          requestId,
          signal,
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
        waitingForSession.delete(waiting);
        let index = 0;
        try {
          await current.promptStarted;
          await this.emitLifecycle({
            kind: "turn",
            id: `${requestId}:started`,
            sessionId: session.id,
            requestId,
            createdAt: Date.now(),
            phase: "started",
          });
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
      completion.resolve(signal.aborted ? { status: "cancelled", stopReason: "cancelled" } : { status: "failed", error: message });
      queue.close();
      if (!signal.aborted && !(error instanceof CleanupTransportBlockedError)) await this.prisma.runtimeSession.updateMany({
        where: { id: input.sessionId, status: { not: "closed" } },
        data: { status: "error", recoveryDetail: message },
      }).catch(() => undefined);
    }).finally(() => {
      releaseCapacity?.();
      waitingForSession.delete(waiting);
      if (!waitingForSession.size) this.waitingTurns.delete(input.sessionId);
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
        waiting.abort();
        if (current) await current.cancel({ reason });
      },
    };
  }

  async enqueue(input: {
    sessionId: string;
    text: string;
    requestId?: string;
    sourceMessageId?: string;
  }): Promise<string> {
    const session = await this.requireSession(input.sessionId);
    if (session.status === "closed") throw new Error("Session is closed");
    // A fallback router can race its recovery pass. Claim source ownership
    // with the instruction so a losing route cannot publish false failure.
    const receipt = await this.prisma.$transaction((tx) => queueInstruction(tx, input));
    void deliverInstructions(this.prisma, this, this.config).catch(() => undefined);
    return receipt.id;
  }

  async steer(_input: { sessionId: string; requestId: string; targetRequestId: string; text: string; beforeSend: () => Promise<boolean> }) {
    // acpx 0.13.2 forwards mode=steer but its manager never interprets it.
    // Starting a concurrent prompt would create a second provider writer.
    return { status: "unsupported" as const, detail: "Installed acpx has no confirmed native active-turn steering capability; this comment remains queued." };
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
    for (const waiting of this.waitingTurns.get(sessionId) ?? []) waiting.abort();
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
    for (const waiting of this.waitingTurns.get(sessionId) ?? []) waiting.abort();
    const session = await this.requireSession(sessionId);
    const handle = this.handles.get(sessionId);
    if (handle) await this.runtimeFor(sessionId).close({ handle, reason });
    else {
      // A confirmed cleanup can close its original logical session after a
      // restart without spawning a provider inside the now-retired checkout.
      const record = await this.loadRecord(session);
      if (!record || record.cwd !== session.cwd || record.acpSessionId !== session.acpxSessionId) throw new Error("Provider close identity is unavailable");
      assertProviderStopped(record);
    }
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
    for (const controllers of this.waitingTurns.values()) for (const waiting of controllers) waiting.abort();
    this.capacity.stop();
    await Promise.allSettled(
      [...this.activeTurns.values()].map((turn) =>
        turn.cancel({ reason: "Remote Agent shutting down" }),
      ),
    );
  }

  async releaseIdleTransports(input: { sessionIds: string[]; check: () => Promise<void>; commit: () => Promise<void> }): Promise<void> {
    const ids = [...new Set(input.sessionIds)].sort();
    const busy = (id: string) => this.recoveringSessions.has(id) || this.turnChains.has(id) || this.activeTurns.has(id) || Boolean(this.waitingTurns.get(id)?.size);
    if (!ids.length || ids.some(busy)) throw new Error("Provider still has local work in flight");
    for (const id of ids) { this.recoveringSessions.add(id); this.releasingSessions.add(id); }
    try {
      await input.check();
      // Validate the entire family before stopping the first owned transport.
      const owned = [];
      for (const id of ids) {
        const session = await this.prisma.runtimeSession.findUniqueOrThrow({ where: { id } });
        if (!["idle", "closed"].includes(session.status)) throw new Error("Provider session is not idle");
        const record = session.acpxRecordId ? await this.store.load(session.acpxRecordId) : undefined;
        if (!record) throw new Error("Provider transport identity is unavailable");
        if (record.acpxRecordId !== session.acpxRecordId || record.cwd !== session.cwd || record.acpSessionId !== session.acpxSessionId
          || record.agentSessionId !== (session.agentSessionId ?? undefined)) throw new Error("Provider transport identity changed");
        const runtime = this.runtimes.get(id), handle = this.handles.get(id);
        if (!runtime || !handle) assertProviderStopped(record);
        else if (handle.acpxRecordId !== record.acpxRecordId || handle.backendSessionId !== record.acpSessionId) throw new Error("Owned provider handle changed");
        owned.push({ id, record, runtime, handle });
      }
      for (const entry of owned) {
        await input.check();
        assertRequestActive();
        if (entry.runtime && entry.handle) await entry.runtime.close({ handle: entry.handle, reason: "Release idle transport for original-task cleanup", discardPersistentState: false });
        // close is a transport acknowledgment, not proof that a stale/foreign
        // provider exited. Observe the exact recorded process before proceeding.
        const deadline = Date.now() + 5_000;
        while (true) {
          try { assertProviderStopped(entry.record); break; }
          catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
        }
        this.handles.delete(entry.id); this.runtimes.delete(entry.id); this.executionDirectories.delete(entry.id);
      }
      await input.check();
      assertRequestActive();
      await input.commit();
    } finally { for (const id of ids) { this.recoveringSessions.delete(id); this.releasingSessions.delete(id); } }
  }

  private async requireSession(sessionId: string): Promise<AgentRuntimeSession> {
    if (this.releasingSessions.has(sessionId)) throw new Error("Session transport transition is in progress");
    const session = await findRuntimeSession(this.prisma, sessionId);
    if (!session) throw new Error(`runtime session not found: ${sessionId}`);
    if (session.status === "closed") {
      throw new Error(`runtime session is closed: ${sessionId}`);
    }
    return session;
  }

  private async handleFor(session: AgentRuntimeSession, executionCwd?: string): Promise<AcpRuntimeHandle> {
    if (!executionCwd) await cleanupExecutionDirectory({ prisma: this.prisma, config: this.config, sessionId: session.id });
    const selected = this.executionDirectories.get(session.id);
    if (selected && selected.execution !== executionCwd) throw new Error("Provider execution directory changed without release");
    if (executionCwd && !selected) {
      if (this.handles.has(session.id) || this.runtimes.has(session.id)) throw new Error("Original provider must be released before cleanup resume");
      this.executionDirectories.set(session.id, { original: session.cwd, execution: executionCwd });
    }
    const existing = this.handles.get(session.id);
    if (existing) return existing;
    const handle = await this.runtimeFor(session.id).ensureSession({
      sessionKey: session.id,
      agent: session.agent,
      mode: "persistent",
      cwd: executionCwd ?? session.cwd,
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
    if (event.phase === "completed") {
      const output = (await this.output(event.sessionId))?.trim() ?? "";
      event = { ...event, output: output.length > 8000 ? `…${output.slice(-8000)}` : output };
    }
    const saved = await appendRuntimeLifecycleEvent(this.prisma, event);
    await recordSourceLifecycle(this.prisma, saved);
    await this.emit(saved);
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
