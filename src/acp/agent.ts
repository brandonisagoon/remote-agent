import * as acp from "@agentclientprotocol/sdk";

import type { AcpConfig } from "./config.ts";
import { acpLog } from "./log.ts";
import { projectEventToAcp } from "./projection.ts";
import type {
  BbClient,
  BbEvent,
  BbModel,
  BbPermissionMode,
  BbProvider,
  BbProviderId,
  BbReasoningLevel,
  BbServiceTier,
  BbThread,
} from "../types/runtime/index.ts";

const EXECUTION_CHILD_TITLE_PREFIX = "Zed ACP execution · ";
const SUPPORTED_PROVIDERS = new Set<BbProviderId>(["codex", "claude-code"]);
const DEFAULT_PERMISSION_MODE: BbPermissionMode = "accept-edits";
const DEFAULT_SERVICE_TIER: BbServiceTier = "default";

const MODE_NAMES: Record<BbPermissionMode, string> = {
  "accept-edits": "Accept Edits",
  auto: "Auto",
  full: "Full Access",
};

const MODE_DESCRIPTIONS: Record<BbPermissionMode, string> = {
  "accept-edits": "Allow workspace edits and ask before broader access.",
  auto: "Let the harness decide when approval is needed.",
  full: "Run without approval prompts, up to the bb host permission ceiling.",
};

interface PromptWaiter {
  resolve: (reason: acp.PromptResponse["stopReason"]) => void;
  message: string;
  accepted: boolean;
}

interface OpenSession {
  rootThread: BbThread;
  executionThread: BbThread;
  executionThreads: BbThread[];
  lastSeq: number;
  abort: AbortController;
  waiter: PromptWaiter | null;
  providers: BbProvider[];
  models: BbModel[];
  model: string;
  reasoningLevel: BbReasoningLevel;
  permissionMode: BbPermissionMode;
  serviceTier: BbServiceTier;
}

function isProviderId(value: string): value is BbProviderId {
  return SUPPORTED_PROVIDERS.has(value as BbProviderId);
}

function promptText(blocks: acp.ContentBlock[]): string {
  return blocks
    .flatMap((block) => {
      if (block.type === "text") return [block.text];
      if (block.type === "resource_link") return [block.uri];
      return [];
    })
    .join("\n")
    .trim();
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export class BbAcpAgent implements acp.Agent {
  private readonly sessions = new Map<string, OpenSession>();

  constructor(
    private readonly connection: acp.AgentSideConnection,
    private readonly bbClient: BbClient,
    private readonly config: AcpConfig,
  ) {}

  async initialize(): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
        sessionCapabilities: { list: {} },
      },
    };
  }

  async authenticate(): Promise<acp.AuthenticateResponse> {
    return {};
  }

  private projectIdForCwd(cwd: string): string {
    return (
      Object.entries(this.config.cwdByProject).find(
        ([, path]) => path === cwd,
      )?.[0] ?? this.config.projectIds[0]!
    );
  }

  private providerRoute(thread?: BbThread): {
    environmentId?: string;
    hostId?: string;
  } {
    if (thread?.environmentId) return { environmentId: thread.environmentId };
    const hostId = thread?.hostId ?? this.config.hostId;
    return hostId ? { hostId } : {};
  }

  private async availableProviders(thread?: BbThread): Promise<BbProvider[]> {
    try {
      return (
        await this.bbClient.listProviders(this.providerRoute(thread))
      ).filter((provider) => provider.available && isProviderId(provider.id));
    } catch (error) {
      acpLog("provider discovery failed", error);
      return [
        {
          id: this.config.providerId,
          displayName:
            this.config.providerId === "codex" ? "Codex" : "Claude Code",
          available: true,
          supportedPermissionModes: ["accept-edits", "auto", "full"],
        },
      ];
    }
  }

  private async availableModels(
    providerId: BbProviderId,
    thread?: BbThread,
  ): Promise<BbModel[]> {
    try {
      return await this.bbClient.listModels({
        providerId,
        ...this.providerRoute(thread),
      });
    } catch (error) {
      acpLog(`model discovery failed for ${providerId}`, error);
      return [];
    }
  }

  private selectedModel(
    models: BbModel[],
    requested?: string,
  ): BbModel | undefined {
    return (
      models.find(
        (model) => model.model === requested || model.id === requested,
      ) ??
      models.find((model) => model.isDefault) ??
      models[0]
    );
  }

  private modeState(state: OpenSession): acp.SessionModeState {
    const provider = state.providers.find(
      (candidate) => candidate.id === state.executionThread.providerId,
    );
    const available = provider?.supportedPermissionModes.length
      ? provider.supportedPermissionModes
      : (["accept-edits", "auto", "full"] satisfies BbPermissionMode[]);
    return {
      currentModeId: state.permissionMode,
      availableModes: available.map((id) => ({
        id,
        name: MODE_NAMES[id],
        description: MODE_DESCRIPTIONS[id],
      })),
    };
  }

  private configOptions(state: OpenSession): acp.SessionConfigOption[] {
    const providerId = isProviderId(state.executionThread.providerId)
      ? state.executionThread.providerId
      : this.config.providerId;
    const selected = this.selectedModel(state.models, state.model);
    const efforts = selected?.supportedReasoningEfforts ?? [];
    const modelConfigId = `model:${providerId}`;
    const effortConfigId = `effort:${providerId}:${selected?.id ?? state.model}`;
    return [
      {
        id: `harness:${state.rootThread.id}`,
        name: "Harness",
        description: "Agent harness backing this bb session.",
        category: "_harness",
        type: "select",
        currentValue: providerId,
        options: state.providers.map((provider) => ({
          value: provider.id,
          name: provider.displayName,
        })),
      },
      {
        id: modelConfigId,
        name: "Model",
        description: "Model used for subsequent turns.",
        category: "model",
        type: "select",
        currentValue: selected?.id ?? state.model,
        options: state.models.map((model) => ({
          value: model.id,
          name: model.displayName,
          description: model.description,
        })),
      },
      {
        id: "mode",
        name: "Mode",
        description: "Permission mode used for subsequent turns.",
        category: "mode",
        type: "select",
        currentValue: state.permissionMode,
        options: this.modeState(state).availableModes.map((mode) => ({
          value: mode.id,
          name: mode.name,
          description: mode.description,
        })),
      },
      {
        id: effortConfigId,
        name: "Effort",
        description: "Reasoning effort used for subsequent turns.",
        category: "thought_level",
        type: "select",
        currentValue: state.reasoningLevel,
        options: efforts.map((effort) => ({
          value: effort.reasoningEffort,
          name: effort.reasoningEffort,
          description: effort.description,
        })),
      },
      {
        id: "speed",
        name: "Speed",
        description: "Service tier used for subsequent turns.",
        category: "model_config",
        type: "select",
        currentValue: state.serviceTier,
        options: [
          {
            value: "default",
            name: "Standard",
            description: "Use the standard provider service tier.",
          },
          {
            value: "fast",
            name: "Fast",
            description:
              "Use the provider's faster service tier when available.",
          },
        ],
      },
    ];
  }

  async newSession(
    params: acp.NewSessionRequest,
  ): Promise<acp.NewSessionResponse> {
    const models = await this.availableModels(this.config.providerId);
    const selected = this.selectedModel(models, this.config.model);
    const thread = await this.bbClient.spawnThread({
      projectId: this.projectIdForCwd(params.cwd),
      worktreePath: params.cwd,
      hostId: this.config.hostId,
      providerId: this.config.providerId,
      model: selected?.model ?? this.config.model,
      title: `Zed · ${params.cwd.split("/").filter(Boolean).at(-1) ?? "session"}`,
      prompt: "A Zed ACP session was created. Wait for the user's request.",
      promptVisibility: "agent-only",
      permissionMode: "accept-edits",
      reasoningLevel: selected?.defaultReasoningEffort,
      serviceTier: DEFAULT_SERVICE_TIER,
    });
    await this.waitForThreadIdle(thread.id);
    await this.open(thread.id, false, true);
    const state = this.sessions.get(thread.id)!;
    return {
      sessionId: thread.id,
      configOptions: this.configOptions(state),
      _meta: this.threadMeta(thread, params.cwd),
    };
  }

  async loadSession(
    params: acp.LoadSessionRequest,
  ): Promise<acp.LoadSessionResponse> {
    const thread = await this.bbClient.getThread(params.sessionId);
    if (!thread || thread.archivedAt) {
      throw acp.RequestError.resourceNotFound(params.sessionId);
    }
    await this.open(thread.id, true);
    const state = this.sessions.get(thread.id)!;
    return {
      configOptions: this.configOptions(state),
      _meta: this.threadMeta(
        thread,
        await this.cwdForThread(thread, params.cwd),
      ),
    };
  }

  async listSessions(
    params: acp.ListSessionsRequest = {},
  ): Promise<acp.ListSessionsResponse> {
    const groups = await Promise.all(
      this.config.projectIds.map((projectId) =>
        this.bbClient.listThreads({ projectId, archived: false }),
      ),
    );
    const sessions = await Promise.all(
      groups
        .flat()
        .filter((thread) => thread.parentThreadId == null)
        .map(async (thread) => {
          const cwd = await this.cwdForThread(thread);
          if (!cwd || (params.cwd && params.cwd !== cwd)) return null;
          return {
            sessionId: thread.id,
            title: thread.title ?? thread.id,
            cwd,
            _meta: this.threadMeta(thread, cwd),
          };
        }),
    );
    return { sessions: sessions.filter((session) => session != null) };
  }

  async setSessionMode(
    params: acp.SetSessionModeRequest,
  ): Promise<acp.SetSessionModeResponse> {
    await this.open(params.sessionId, false);
    const state = this.sessions.get(params.sessionId)!;
    const available = this.modeState(state).availableModes.map(
      (mode) => mode.id,
    );
    if (!available.includes(params.modeId)) {
      throw acp.RequestError.invalidParams({
        message: `unsupported mode ${params.modeId}`,
      });
    }
    state.permissionMode = params.modeId as BbPermissionMode;
    return {};
  }

  async setSessionConfigOption(
    params: acp.SetSessionConfigOptionRequest,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    if (typeof params.value !== "string") {
      throw acp.RequestError.invalidParams({
        message: "select value required",
      });
    }
    await this.open(params.sessionId, false);
    const state = this.sessions.get(params.sessionId)!;
    if (
      params.configId === "harness" ||
      params.configId === `harness:${params.sessionId}`
    ) {
      if (!isProviderId(params.value)) {
        throw acp.RequestError.invalidParams({
          message: "unsupported harness",
        });
      }
      const available = state.providers.some(
        (provider) => provider.id === params.value,
      );
      if (!available) {
        throw acp.RequestError.invalidParams({
          message: "harness is unavailable",
        });
      }
      if (state.executionThread.providerId !== params.value) {
        await this.switchHarness(params.sessionId, state, params.value);
      }
    } else if (
      params.configId === "model" ||
      params.configId === `model:${state.executionThread.providerId}`
    ) {
      const model = state.models.find(
        (candidate) => candidate.id === params.value,
      );
      if (!model)
        throw acp.RequestError.invalidParams({ message: "unsupported model" });
      state.model = model.model;
      const supported = model.supportedReasoningEfforts.some(
        (effort) => effort.reasoningEffort === state.reasoningLevel,
      );
      if (!supported) state.reasoningLevel = model.defaultReasoningEffort;
      await this.bbClient.updateThreadExecutionOptions({
        threadId: state.executionThread.id,
        model: state.model,
        reasoningLevel: state.reasoningLevel,
      });
    } else if (params.configId === "mode") {
      const available = this.modeState(state).availableModes.map(
        (mode) => mode.id,
      );
      if (!available.includes(params.value)) {
        throw acp.RequestError.invalidParams({ message: "unsupported mode" });
      }
      state.permissionMode = params.value as BbPermissionMode;
    } else if (
      params.configId === "effort" ||
      params.configId.startsWith(`effort:${state.executionThread.providerId}:`)
    ) {
      const model = this.selectedModel(state.models, state.model);
      const supported = model?.supportedReasoningEfforts.some(
        (effort) => effort.reasoningEffort === params.value,
      );
      if (!supported) {
        throw acp.RequestError.invalidParams({ message: "unsupported effort" });
      }
      state.reasoningLevel = params.value as BbReasoningLevel;
      await this.bbClient.updateThreadExecutionOptions({
        threadId: state.executionThread.id,
        reasoningLevel: state.reasoningLevel,
      });
    } else if (params.configId === "speed") {
      if (params.value !== "default" && params.value !== "fast") {
        throw acp.RequestError.invalidParams({ message: "unsupported speed" });
      }
      state.serviceTier = params.value;
    } else {
      throw acp.RequestError.invalidParams({
        message: "unknown configuration option",
      });
    }
    return { configOptions: this.configOptions(state) };
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const message = promptText(params.prompt);
    if (!message)
      throw acp.RequestError.invalidParams({ message: "text prompt required" });
    await this.open(params.sessionId, false);
    const session = this.sessions.get(params.sessionId)!;
    session.waiter?.resolve("cancelled");
    const completion = new Promise<acp.PromptResponse["stopReason"]>(
      (resolve) => {
        session.waiter = { resolve, message, accepted: false };
      },
    );
    try {
      await this.bbClient.sendMessage({
        threadId: session.executionThread.id,
        message,
        mode: "queue-if-active",
        model: session.model,
        reasoningLevel: session.reasoningLevel,
        permissionMode: session.permissionMode,
        serviceTier: session.serviceTier,
      });
    } catch (error) {
      session.waiter = null;
      throw error;
    }
    return { stopReason: await completion };
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    session?.waiter?.resolve("cancelled");
    if (session) session.waiter = null;
    const threadId = session?.executionThread.id ?? params.sessionId;
    await this.bbClient
      .stopThread(threadId)
      .catch((error) => acpLog(`cancel failed for ${params.sessionId}`, error));
  }

  private threadMeta(
    thread: BbThread,
    cwd?: string | null,
  ): Record<string, unknown> {
    return {
      bbThreadId: thread.id,
      projectId: thread.projectId,
      environmentId: thread.environmentId,
      hostId: thread.hostId,
      providerId: thread.providerId,
      cwd: cwd ?? this.config.cwdByProject[thread.projectId] ?? null,
    };
  }

  private async cwdForThread(
    thread: BbThread,
    fallback?: string,
  ): Promise<string | null> {
    if (thread.environmentId) {
      const environment = await this.bbClient
        .getEnvironment(thread.environmentId)
        .catch((error) => {
          acpLog(`environment lookup failed for ${thread.id}`, error);
          return null;
        });
      if (environment?.path) return environment.path;
    }
    return fallback ?? this.config.cwdByProject[thread.projectId] ?? null;
  }

  private async executionThreadsForRoot(
    rootThread: BbThread,
  ): Promise<BbThread[]> {
    const threads = await this.bbClient.listThreads({
      projectId: rootThread.projectId,
      archived: false,
      includeHidden: true,
    });
    const children = threads
      .filter(
        (thread) =>
          (thread.parentThreadId === rootThread.id &&
            thread.title?.startsWith(EXECUTION_CHILD_TITLE_PREFIX)) ||
          (thread.parentThreadId == null &&
            thread.visibility === "hidden" &&
            thread.title?.startsWith(
              `${EXECUTION_CHILD_TITLE_PREFIX}${rootThread.id} · `,
            )),
      )
      .sort(
        (left, right) =>
          (left.createdAt ?? 0) - (right.createdAt ?? 0) ||
          left.id.localeCompare(right.id),
      );
    return [rootThread, ...children];
  }

  private async waitForThreadIdle(threadId: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const thread = await this.bbClient.getThread(threadId);
      if (!thread || thread.status === "idle" || thread.status === "error")
        return;
      await Bun.sleep(100);
    }
    acpLog(`timed out waiting for bootstrap turn on ${threadId}`);
  }

  private visibleEvents(events: BbEvent[]): BbEvent[] {
    const first = events[0];
    const data = record(first?.data);
    const input = Array.isArray(data?.input) ? data.input : [];
    const isInternalBootstrap =
      first?.type === "client/turn/requested" &&
      input.some((value) => record(value)?.visibility === "agent-only");
    if (!isInternalBootstrap) return events;
    const completed = events.findIndex(
      (event) => event.type === "turn/completed",
    );
    return completed < 0 ? [] : events.slice(completed + 1);
  }

  private async createState(
    rootThread: BbThread,
    executionThreads: BbThread[],
  ): Promise<OpenSession> {
    const executionThread = executionThreads.at(-1) ?? rootThread;
    const providers = await this.availableProviders(executionThread);
    if (
      isProviderId(executionThread.providerId) &&
      !providers.some((provider) => provider.id === executionThread.providerId)
    ) {
      providers.push({
        id: executionThread.providerId,
        displayName:
          executionThread.providerId === "codex" ? "Codex" : "Claude Code",
        available: true,
        supportedPermissionModes: ["accept-edits", "auto", "full"],
      });
    }
    const providerId = isProviderId(executionThread.providerId)
      ? executionThread.providerId
      : this.config.providerId;
    const options = await this.bbClient.getThreadExecutionOptions(
      executionThread.id,
    );
    const models = await this.availableModels(providerId, executionThread);
    const requestedModel = options?.model ?? this.config.model;
    let selected = this.selectedModel(models, requestedModel);
    const reasoningLevel =
      options?.reasoningLevel ?? selected?.defaultReasoningEffort ?? "medium";
    if (requestedModel && !selected) {
      selected = {
        id: requestedModel,
        model: requestedModel,
        displayName: requestedModel,
        description: "Current bb thread model.",
        supportedReasoningEfforts: [
          {
            reasoningEffort: reasoningLevel,
            description: "Current reasoning effort.",
          },
        ],
        defaultReasoningEffort: reasoningLevel,
        isDefault: true,
      };
      models.push(selected);
    }
    const provider = providers.find((candidate) => candidate.id === providerId);
    const permissionMode =
      options?.permissionMode &&
      provider?.supportedPermissionModes.includes(options.permissionMode)
        ? options.permissionMode
        : (provider?.supportedPermissionModes[0] ?? DEFAULT_PERMISSION_MODE);
    return {
      rootThread,
      executionThread,
      executionThreads,
      lastSeq: 0,
      abort: new AbortController(),
      waiter: null,
      providers,
      models,
      model: selected?.model ?? requestedModel ?? "default",
      reasoningLevel,
      permissionMode,
      serviceTier: options?.serviceTier ?? DEFAULT_SERVICE_TIER,
    };
  }

  private async transcriptFor(state: OpenSession): Promise<string> {
    const lines: string[] = [];
    for (const thread of state.executionThreads) {
      const events = this.visibleEvents(
        await this.bbClient.listEvents({ threadId: thread.id }),
      );
      for (const event of events) {
        for (const update of projectEventToAcp(event)) {
          if (
            update.sessionUpdate !== "user_message_chunk" &&
            update.sessionUpdate !== "agent_message_chunk"
          )
            continue;
          if (update.content.type !== "text") continue;
          const role =
            update.sessionUpdate === "user_message_chunk" ? "User" : "Agent";
          const line = `${role}: ${update.content.text}`;
          if (lines.at(-1) !== line) lines.push(line);
        }
      }
    }
    return lines.join("\n\n").slice(-24_000);
  }

  private async switchHarness(
    sessionId: string,
    state: OpenSession,
    providerId: BbProviderId,
  ): Promise<void> {
    const models = await this.availableModels(
      providerId,
      state.executionThread,
    );
    const selected = this.selectedModel(models);
    const provider = state.providers.find(
      (candidate) => candidate.id === providerId,
    );
    const permissionMode = provider?.supportedPermissionModes.includes(
      state.permissionMode,
    )
      ? state.permissionMode
      : (provider?.supportedPermissionModes[0] ?? DEFAULT_PERMISSION_MODE);
    const transcript = await this.transcriptFor(state);
    const cwd = await this.cwdForThread(state.rootThread);
    if (!cwd)
      throw acp.RequestError.invalidParams({
        message: "session cwd unavailable",
      });
    const thread = await this.bbClient.spawnThread({
      projectId: state.rootThread.projectId,
      worktreePath: cwd,
      hostId: state.rootThread.hostId ?? this.config.hostId,
      providerId,
      model: selected?.model,
      reasoningLevel: selected?.defaultReasoningEffort,
      permissionMode,
      serviceTier: state.serviceTier,
      visibility: "hidden",
      title: `${EXECUTION_CHILD_TITLE_PREFIX}${sessionId} · ${providerId}`,
      prompt: transcript
        ? `Continue this Zed ACP session using the prior conversation below. Preserve its context, but wait for the user's next request.\n\n${transcript}`
        : "A Zed ACP session selected this harness. Wait for the user's request.",
      promptVisibility: "agent-only",
    });
    await this.waitForThreadIdle(thread.id);
    const existingEvents = await this.bbClient.listEvents({
      threadId: thread.id,
    });
    state.waiter?.resolve("cancelled");
    state.waiter = null;
    state.abort.abort();
    state.executionThread = thread;
    state.executionThreads.push(thread);
    state.models = models;
    state.model = selected?.model ?? "default";
    state.reasoningLevel = selected?.defaultReasoningEffort ?? "medium";
    state.permissionMode = permissionMode;
    state.lastSeq = existingEvents.at(-1)?.seq ?? 0;
    state.abort = new AbortController();
    void this.tail(sessionId, state, thread.id, state.abort);
  }

  private async open(
    sessionId: string,
    replay: boolean,
    skipExisting = false,
  ): Promise<void> {
    if (this.sessions.has(sessionId)) return;
    const rootThread = await this.bbClient.getThread(sessionId);
    if (!rootThread || rootThread.archivedAt) {
      throw acp.RequestError.resourceNotFound(sessionId);
    }
    const executionThreads = await this.executionThreadsForRoot(rootThread);
    const state = await this.createState(rootThread, executionThreads);
    this.sessions.set(sessionId, state);
    if (replay) {
      for (const thread of executionThreads) {
        const events = await this.bbClient.listEvents({ threadId: thread.id });
        for (const event of this.visibleEvents(events)) {
          for (const update of projectEventToAcp(event)) {
            await this.connection.sessionUpdate({ sessionId, update });
          }
          if (
            thread.id === state.executionThread.id &&
            event.type === "system/userQuestion/lifecycle"
          ) {
            await this.handleQuestion(sessionId, event);
          }
        }
        if (thread.id === state.executionThread.id) {
          state.lastSeq = events.at(-1)?.seq ?? 0;
        }
      }
    } else if (skipExisting) {
      const events = await this.bbClient.listEvents({
        threadId: state.executionThread.id,
      });
      state.lastSeq = events.at(-1)?.seq ?? 0;
    }
    void this.tail(sessionId, state, state.executionThread.id, state.abort);
  }

  private async tail(
    sessionId: string,
    state: OpenSession,
    threadId: string,
    abort: AbortController,
  ): Promise<void> {
    while (!abort.signal.aborted && state.executionThread.id === threadId) {
      try {
        for await (const event of this.bbClient.streamEvents({
          threadId,
          afterSeq: state.lastSeq,
          signal: abort.signal,
        })) {
          if (state.executionThread.id !== threadId) return;
          await this.advance(sessionId, state, event);
        }
      } catch (error) {
        if (abort.signal.aborted) return;
        acpLog(`event tail reconnecting for ${threadId}`, error);
        await Bun.sleep(1_000);
      }
    }
  }

  private async advance(
    sessionId: string,
    state: OpenSession,
    event: BbEvent,
  ): Promise<void> {
    if (event.seq <= state.lastSeq) return;
    state.lastSeq = event.seq;
    for (const update of projectEventToAcp(event)) {
      await this.connection.sessionUpdate({ sessionId, update });
    }
    if (state.waiter && this.eventAcceptsPrompt(event, state.waiter.message)) {
      state.waiter.accepted = true;
    }
    if (event.type === "turn/completed" && state.waiter?.accepted) {
      const data = record(event.data);
      const reason = data?.status === "interrupted" ? "cancelled" : "end_turn";
      state.waiter?.resolve(reason);
      state.waiter = null;
    }
    if (event.type === "system/userQuestion/lifecycle") {
      await this.handleQuestion(sessionId, event);
    }
  }

  private eventAcceptsPrompt(event: BbEvent, message: string): boolean {
    const data = record(event.data);
    if (event.type === "system/manager/user_message") {
      return data?.text === message;
    }
    if (event.type === "client/turn/requested" && Array.isArray(data?.input)) {
      return data.input.some((blockValue) => {
        const block = record(blockValue);
        return block?.type === "text" && block.text === message;
      });
    }
    if (event.type !== "item/started") return false;
    const item = record(data?.item);
    if (item?.type !== "userMessage" || !Array.isArray(item.content))
      return false;
    return item.content.some((blockValue) => {
      const block = record(blockValue);
      return block?.type === "text" && block.text === message;
    });
  }

  private async handleQuestion(
    sessionId: string,
    event: BbEvent,
  ): Promise<void> {
    const data = record(event.data);
    if (data?.status !== "pending") return;
    const payload = record(data.payload);
    const questions = Array.isArray(payload?.questions)
      ? payload.questions
      : [];
    const interactionId =
      typeof data?.interactionId === "string" ? data.interactionId : null;
    if (!interactionId) return;
    const answers: Record<string, { selected: string[] }> = {};
    for (const questionValue of questions) {
      const question = record(questionValue);
      const questionId = typeof question?.id === "string" ? question.id : null;
      const options = Array.isArray(question?.options) ? question.options : [];
      if (!questionId || options.length === 0) return;
      const response = await this.connection.requestPermission({
        sessionId,
        toolCall: {
          toolCallId: `${interactionId}:${questionId}`,
          title:
            typeof question?.prompt === "string" ? question.prompt : "Question",
          kind: "other",
          status: "pending",
        },
        options: options.flatMap((option) => {
          const value = record(option);
          return typeof value?.value === "string" &&
            typeof value.label === "string"
            ? [
                {
                  optionId: value.value,
                  name: value.label,
                  kind: "allow_once" as const,
                },
              ]
            : [];
        }),
      });
      if (response.outcome.outcome === "cancelled") return;
      answers[questionId] = { selected: [response.outcome.optionId] };
    }
    await this.bbClient.resolveInteraction({
      threadId: event.threadId,
      interactionId,
      resolution: {
        kind: "user_answer",
        answers,
      },
    });
  }
}
