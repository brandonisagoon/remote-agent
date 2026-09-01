import type { SessionConfigOption } from "@agentclientprotocol/sdk";

import type {
  AgentRuntimeEvent,
  AgentRuntimeMessage,
  AgentRuntimeSession,
  AgentRuntimeTurn,
  AgentSessionRuntime,
  EnsureAgentSessionInput,
} from "../types/runtime/index.ts";

export interface FakeAgentRuntime extends AgentSessionRuntime {
  sessions: Map<string, AgentRuntimeSession>;
  ensureInputs: EnsureAgentSessionInput[];
  sentMessages: Array<{ sessionId: string; text: string; requestId?: string }>;
  cancelledSessionIds: string[];
  closedSessionIds: string[];
  putSession(session: Partial<AgentRuntimeSession> & { id: string }): void;
}

export function fakeRuntimeSession(
  input: Partial<AgentRuntimeSession> & { id: string },
): AgentRuntimeSession {
  return {
    scopeKey: `scope:${input.id}`,
    acpxRecordId: `record:${input.id}`,
    acpxSessionId: `acp:${input.id}`,
    agentSessionId: `provider:${input.id}`,
    agent: "codex",
    repositoryId: "test-repository",
    machineId: "macbook-air",
    role: null,
    lifecycle: null,
    cwd: "/tmp/repo",
    name: input.id,
    worktreePath: "/tmp/repo",
    executionTarget: "macbook-air",
    status: "idle",
    configOptions: [],
    usage: null,
    closedAt: null,
    ...input,
  };
}

export function createFakeAgentRuntime(
  initial: Array<Partial<AgentRuntimeSession> & { id: string }> = [],
): FakeAgentRuntime {
  const sessions = new Map(
    initial.map((session) => [session.id, fakeRuntimeSession(session)]),
  );
  const ensureInputs: EnsureAgentSessionInput[] = [];
  const sentMessages: FakeAgentRuntime["sentMessages"] = [];
  const cancelledSessionIds: string[] = [];
  const closedSessionIds: string[] = [];
  const histories = new Map<string, AgentRuntimeMessage[]>();
  const listeners = new Map<
    string,
    Set<(event: AgentRuntimeEvent) => void | Promise<void>>
  >();
  const globalListeners = new Set<
    (event: AgentRuntimeEvent) => void | Promise<void>
  >();

  const runtime: FakeAgentRuntime = {
    sessions,
    ensureInputs,
    sentMessages,
    cancelledSessionIds,
    closedSessionIds,
    putSession(session) {
      sessions.set(session.id, fakeRuntimeSession(session));
    },
    async ensureSession(input) {
      ensureInputs.push(input);
      const existing = [...sessions.values()].find(
        (session) => session.name === input.name && session.cwd === input.cwd,
      );
      if (existing) return existing;
      const id = `runtime-${sessions.size + 1}`;
      const session = fakeRuntimeSession({
        id,
        agent: input.agent,
        cwd: input.cwd,
        worktreePath: input.worktreePath ?? input.cwd,
        executionTarget: input.executionTarget ?? null,
        name: input.name ?? input.sessionKey,
      });
      sessions.set(id, session);
      return session;
    },
    async getSession(sessionId) {
      return sessions.get(sessionId) ?? null;
    },
    async listSessions(input = {}) {
      return [...sessions.values()].filter(
        (session) =>
          (!input.cwd || session.cwd === input.cwd) &&
          (input.includeClosed || session.status !== "closed"),
      );
    },
    async history(sessionId) {
      return histories.get(sessionId) ?? [];
    },
    startTurn(input): AgentRuntimeTurn {
      sentMessages.push({
        sessionId: input.sessionId,
        text: input.text,
        ...(input.requestId ? { requestId: input.requestId } : {}),
      });
      return {
        requestId: input.requestId ?? `request-${sentMessages.length}`,
        events: {
          async *[Symbol.asyncIterator]() {
            // No events by default.
          },
        },
        result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
        cancel: async () => {
          cancelledSessionIds.push(input.sessionId);
        },
      };
    },
    async enqueue(input) {
      sentMessages.push({
        sessionId: input.sessionId,
        text: input.text,
        ...(input.requestId ? { requestId: input.requestId } : {}),
      });
      return input.requestId ?? `request-${sentMessages.length}`;
    },
    async setMode() {},
    async setConfigOption(sessionId, key, value) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error("session not found");
      const configOptions = session.configOptions.map((option) =>
        option.id === key
          ? ({ ...option, currentValue: value } as SessionConfigOption)
          : option,
      );
      sessions.set(sessionId, { ...session, configOptions });
      return configOptions;
    },
    async switchAgent(sessionId, agent) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error("session not found");
      const next = { ...session, agent };
      sessions.set(sessionId, next);
      return next;
    },
    async cancel(sessionId) {
      cancelledSessionIds.push(sessionId);
    },
    async close(sessionId) {
      const session = sessions.get(sessionId);
      if (session) {
        sessions.set(sessionId, {
          ...session,
          status: "closed",
          closedAt: new Date(),
        });
      }
      closedSessionIds.push(sessionId);
    },
    async output(sessionId) {
      const history = histories.get(sessionId) ?? [];
      for (let index = history.length - 1; index >= 0; index -= 1) {
        if (history[index]?.role === "agent") return history[index]!.text;
      }
      return null;
    },
    subscribe(sessionId, listener) {
      const set = listeners.get(sessionId) ?? new Set();
      set.add(listener);
      listeners.set(sessionId, set);
      return () => set.delete(listener);
    },
    subscribeAll(listener) {
      globalListeners.add(listener);
      return () => globalListeners.delete(listener);
    },
    async shutdown() {},
  };
  return runtime;
}
