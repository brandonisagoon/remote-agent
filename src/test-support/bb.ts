import type {
  BbClient,
  BbEnvironment,
  BbEvent,
  BbExecutionOptions,
  BbMachine,
  BbModel,
  BbPendingInteraction,
  BbProvider,
  BbProviderId,
  BbThread,
} from "../types/runtime/bb.ts";

export interface FakeBbClient extends BbClient {
  readonly sentMessages: Array<{
    threadId: string;
    message: string;
    mode: string;
    model?: string;
    reasoningLevel?: string;
    permissionMode?: string;
    serviceTier?: string;
  }>;
  readonly openedThreadIds: string[];
  readonly stoppedThreadIds: string[];
  readonly archivedThreadIds: string[];
  readonly spawnInputs: Parameters<BbClient["spawnThread"]>[0][];
  readonly resolvedInteractions: Parameters<
    BbClient["resolveInteraction"]
  >[0][];
  pushEvent(event: BbEvent): void;
  putThread(thread: BbThread): void;
  putEnvironment(environment: BbEnvironment): void;
  setMachines(machines: BbMachine[]): void;
  setProviders(providers: BbProvider[]): void;
  setModels(providerId: BbProviderId, models: BbModel[]): void;
  setExecutionOptions(threadId: string, options: BbExecutionOptions): void;
}

export function createFakeBbClient(
  initialThreads: BbThread[] = [],
): FakeBbClient {
  const threads = new Map(initialThreads.map((thread) => [thread.id, thread]));
  const environments = new Map<string, BbEnvironment>();
  const events = new Map<string, BbEvent[]>();
  const interactions = new Map<string, BbPendingInteraction[]>();
  const executionOptions = new Map<string, BbExecutionOptions>();
  const models = new Map<BbProviderId, BbModel[]>();
  const waiters = new Set<() => void>();
  let machines: BbMachine[] = [];
  let providers: BbProvider[] = [
    {
      id: "codex",
      displayName: "Codex",
      available: true,
      supportedPermissionModes: ["accept-edits", "auto", "full"],
    },
    {
      id: "claude-code",
      displayName: "Claude Code",
      available: true,
      supportedPermissionModes: ["accept-edits", "auto", "full"],
    },
  ];
  const sentMessages: FakeBbClient["sentMessages"] = [];
  const openedThreadIds: string[] = [];
  const stoppedThreadIds: string[] = [];
  const archivedThreadIds: string[] = [];
  const spawnInputs: FakeBbClient["spawnInputs"] = [];
  const resolvedInteractions: FakeBbClient["resolvedInteractions"] = [];
  let nextThread = initialThreads.length + 1;

  const wake = () => {
    for (const waiter of waiters) waiter();
    waiters.clear();
  };

  return {
    sentMessages,
    openedThreadIds,
    stoppedThreadIds,
    archivedThreadIds,
    spawnInputs,
    resolvedInteractions,
    async getThread(threadId) {
      return threads.get(threadId) ?? null;
    },
    async openThread(threadId) {
      if (!threads.has(threadId)) throw new Error("bb thread not found");
      openedThreadIds.push(threadId);
      return 1;
    },
    async getThreadOutput() {
      return null;
    },
    async getThreadExecutionOptions(threadId) {
      return executionOptions.get(threadId) ?? null;
    },
    async getEnvironment(environmentId) {
      return environments.get(environmentId) ?? null;
    },
    async listThreads(input = {}) {
      return [...threads.values()].filter(
        (thread) =>
          (!input.projectId || thread.projectId === input.projectId) &&
          (input.archived === undefined ||
            Boolean(thread.archivedAt) === input.archived) &&
          (input.includeHidden || thread.visibility !== "hidden"),
      );
    },
    async listProviders() {
      return [...providers];
    },
    async listModels(input) {
      return [...(models.get(input.providerId) ?? [])];
    },
    async listEvents(input) {
      return (events.get(input.threadId) ?? [])
        .filter((event) => event.seq > (input.afterSeq ?? 0))
        .sort((left, right) => left.seq - right.seq);
    },
    async listInteractions(threadId) {
      return interactions.get(threadId) ?? [];
    },
    async resolveInteraction(input) {
      resolvedInteractions.push(input);
    },
    async sendMessage(input) {
      if (!threads.has(input.threadId)) throw new Error("bb thread not found");
      const sent = {
        threadId: input.threadId,
        message: input.message,
        mode: input.mode ?? "queue-if-active",
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoningLevel
          ? { reasoningLevel: input.reasoningLevel }
          : {}),
        ...(input.permissionMode
          ? { permissionMode: input.permissionMode }
          : {}),
        ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
      };
      sentMessages.push(sent);
      const current = executionOptions.get(input.threadId);
      if (current) {
        executionOptions.set(input.threadId, {
          ...current,
          model: input.model ?? current.model,
          reasoningLevel: input.reasoningLevel ?? current.reasoningLevel,
          permissionMode: input.permissionMode ?? current.permissionMode,
          serviceTier: input.serviceTier ?? current.serviceTier,
        });
      }
    },
    async spawnThread(input) {
      spawnInputs.push(input);
      const thread: BbThread = {
        id: `thr_fake_${nextThread++}`,
        projectId: input.projectId,
        environmentId: null,
        hostId: input.hostId ?? null,
        providerId: input.providerId,
        title: input.title ?? null,
        status: "idle",
        parentThreadId: input.parentThreadId ?? null,
        archivedAt: null,
        createdAt: Date.now() + nextThread,
        visibility: input.visibility ?? "visible",
      };
      threads.set(thread.id, thread);
      executionOptions.set(thread.id, {
        model: input.model ?? "default-model",
        reasoningLevel: input.reasoningLevel ?? "medium",
        permissionMode: input.permissionMode ?? "accept-edits",
        serviceTier: input.serviceTier ?? "default",
      });
      return thread;
    },
    async updateThreadExecutionOptions(input) {
      const current = executionOptions.get(input.threadId);
      if (!current) throw new Error("bb thread not found");
      executionOptions.set(input.threadId, {
        ...current,
        model: input.model ?? current.model,
        reasoningLevel: input.reasoningLevel ?? current.reasoningLevel,
      });
    },
    async stopThread(threadId) {
      const thread = threads.get(threadId);
      if (!thread) throw new Error("bb thread not found");
      threads.set(threadId, { ...thread, status: "idle" });
      stoppedThreadIds.push(threadId);
    },
    async archiveThread(threadId) {
      const thread = threads.get(threadId);
      if (!thread) throw new Error("bb thread not found");
      threads.set(threadId, { ...thread, archivedAt: Date.now() });
      archivedThreadIds.push(threadId);
    },
    async listMachines() {
      return [...machines];
    },
    async *streamEvents(input) {
      let cursor = input.afterSeq ?? 0;
      while (!input.signal?.aborted) {
        const next = (events.get(input.threadId) ?? [])
          .filter((event) => event.seq > cursor)
          .sort((left, right) => left.seq - right.seq);
        if (next.length > 0) {
          for (const event of next) {
            cursor = event.seq;
            yield event;
          }
          continue;
        }
        await new Promise<void>((resolve) => {
          const done = () => {
            input.signal?.removeEventListener("abort", done);
            waiters.delete(done);
            resolve();
          };
          waiters.add(done);
          input.signal?.addEventListener("abort", done, { once: true });
        });
      }
    },
    pushEvent(event) {
      const current = events.get(event.threadId) ?? [];
      current.push(event);
      events.set(event.threadId, current);
      wake();
    },
    putThread(thread) {
      threads.set(thread.id, thread);
    },
    putEnvironment(environment) {
      environments.set(environment.id, environment);
    },
    setMachines(value) {
      machines = [...value];
    },
    setProviders(value) {
      providers = [...value];
    },
    setModels(providerId, value) {
      models.set(providerId, [...value]);
    },
    setExecutionOptions(threadId, value) {
      executionOptions.set(threadId, value);
    },
  };
}
