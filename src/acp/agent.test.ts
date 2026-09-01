import { describe, expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";

import { testConfig } from "../test-support/config.ts";
import type {
  AgentRuntimeEvent,
  AgentRuntimeMessage,
  AgentRuntimeSession,
  AgentRuntimeTurn,
  AgentSessionRuntime,
  EnsureAgentSessionInput,
} from "../types/runtime/index.ts";
import { RemoteAgentAcpAgent } from "./agent.ts";

function baseSession(): AgentRuntimeSession {
  return {
    id: "runtime-1",
    scopeKey: "scope-1",
    acpxRecordId: "record-1",
    acpxSessionId: "acp-1",
    agentSessionId: "provider-1",
    agent: "codex",
    repositoryId: "test-repository",
    machineId: "macbook-air",
    role: null,
    lifecycle: null,
    cwd: "/repo",
    name: "Zed test",
    worktreePath: "/repo",
    executionTarget: "macbook-air",
    status: "idle",
    closedAt: null,
    usage: { used: 25_000, size: 100_000 },
    configOptions: [
      {
        id: "model:codex:gpt-5",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "gpt-5",
        options: [
          { value: "gpt-5", name: "GPT-5" },
          { value: "gpt-6", name: "GPT-6" },
        ],
      },
      {
        id: "effort:codex:gpt-5",
        name: "Thinking",
        category: "thought_level",
        type: "select",
        currentValue: "medium",
        options: [
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
      {
        id: "service_tier",
        name: "Service Tier",
        category: "model_config",
        type: "select",
        currentValue: "default",
        options: [
          { value: "default", name: "Standard" },
          { value: "fast", name: "Fast" },
        ],
      },
    ],
  };
}

class FakeRuntime implements AgentSessionRuntime {
  session = baseSession();
  historyMessages: AgentRuntimeMessage[] = [];
  turnEvents: AgentRuntimeEvent[] = [];
  ensures: EnsureAgentSessionInput[] = [];
  configSets: Array<{ key: string; value: string }> = [];
  cancelled = 0;

  async ensureSession(input: EnsureAgentSessionInput) {
    this.ensures.push(input);
    this.session = { ...this.session, cwd: input.cwd };
    return this.session;
  }
  async getSession(id: string) {
    return id === this.session.id ? this.session : null;
  }
  async listSessions(input: { cwd?: string } = {}) {
    return !input.cwd || input.cwd === this.session.cwd ? [this.session] : [];
  }
  async history() {
    return this.historyMessages;
  }
  startTurn(): AgentRuntimeTurn {
    const events = this.turnEvents;
    return {
      requestId: "request-1",
      events: {
        async *[Symbol.asyncIterator]() {
          yield* events;
        },
      },
      result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
      cancel: async () => {
        this.cancelled += 1;
      },
    };
  }
  async enqueue() {
    return "request-1";
  }
  async setMode() {}
  async setConfigOption(_sessionId: string, key: string, value: string) {
    this.configSets.push({ key, value });
    if (key.startsWith("model:")) {
      this.session = {
        ...this.session,
        configOptions: [
          ({
            ...this.session.configOptions[0]!,
            id: "model:codex:gpt-6",
            currentValue: value,
          } as acp.SessionConfigOption),
          ({
            ...this.session.configOptions[1]!,
            id: "effort:codex:gpt-6",
            currentValue: "high",
            options: [{ value: "high", name: "High" }],
          } as acp.SessionConfigOption),
          this.session.configOptions[2]!,
        ],
      };
    } else if (key === "service_tier") {
      this.session = {
        ...this.session,
        configOptions: this.session.configOptions.map((option) =>
          option.id === key && option.type === "select"
            ? { ...option, currentValue: value }
            : option,
        ),
      };
    }
    return this.session.configOptions;
  }
  async switchAgent(_sessionId: string, agent: "codex" | "claude") {
    this.session = { ...this.session, agent };
    return this.session;
  }
  async cancel() {
    this.cancelled += 1;
  }
  async close() {
    this.session = { ...this.session, status: "closed" };
  }
  async output() {
    return null;
  }
  subscribe() {
    return () => {};
  }
  subscribeAll() {
    return () => {};
  }
  async shutdown() {}
}

function connection(updates: acp.SessionNotification[]) {
  return {
    async sessionUpdate(notification: acp.SessionNotification) {
      updates.push(notification);
    },
  } as unknown as acp.AgentSideConnection;
}

function initialize(agent: RemoteAgentAcpAgent, boolean = true) {
  return agent.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: boolean
      ? { session: { configOptions: { boolean: {} } } }
      : {},
  });
}

describe("Remote Agent ACP proxy", () => {
  test("creates one acpx mapping and advertises reconnect lifecycle", async () => {
    const runtime = new FakeRuntime();
    const agent = new RemoteAgentAcpAgent(
      connection([]),
      runtime,
      testConfig(),
    );
    const initialized = await initialize(agent);
    expect(initialized.agentCapabilities).toMatchObject({
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {}, close: {} },
    });
    const created = await agent.newSession({ cwd: "/repo", mcpServers: [] });
    expect(created.sessionId).toBe("runtime-1");
    expect(runtime.ensures).toHaveLength(1);
    expect(runtime.ensures[0]).toMatchObject({
      agent: "codex",
      cwd: "/repo",
      executionTarget: "macbook-air",
    });
  });

  test("uses stable Zed IDs, thought category, and boolean fast mode", async () => {
    const runtime = new FakeRuntime();
    const agent = new RemoteAgentAcpAgent(connection([]), runtime, testConfig());
    await initialize(agent);
    const loaded = await agent.resumeSession({
      sessionId: "runtime-1",
      cwd: "/repo",
      mcpServers: [],
    });
    expect(loaded.configOptions).toMatchObject([
      { id: "harness", currentValue: "codex" },
      { id: "model", currentValue: "gpt-5", category: "model" },
      {
        id: "reasoning_effort",
        currentValue: "medium",
        category: "thought_level",
      },
      {
        id: "fast_mode",
        type: "boolean",
        currentValue: false,
        category: "model_config",
      },
    ]);

    const changed = await agent.setSessionConfigOption({
      sessionId: "runtime-1",
      configId: "model",
      value: "gpt-6",
    });
    expect(runtime.configSets[0]).toEqual({
      key: "model:codex:gpt-5",
      value: "gpt-6",
    });
    expect(changed.configOptions).toMatchObject([
      { id: "harness" },
      { id: "model", currentValue: "gpt-6" },
      { id: "reasoning_effort", currentValue: "high" },
      { id: "fast_mode", currentValue: false },
    ]);
  });

  test("translates Zed's fast boolean to the upstream select", async () => {
    const runtime = new FakeRuntime();
    const agent = new RemoteAgentAcpAgent(connection([]), runtime, testConfig());
    await initialize(agent);
    const response = await agent.setSessionConfigOption({
      sessionId: "runtime-1",
      configId: "fast_mode",
      type: "boolean",
      value: true,
    });
    expect(runtime.configSets).toEqual([{ key: "service_tier", value: "fast" }]);
    expect(response.configOptions.at(-1)).toMatchObject({
      id: "fast_mode",
      type: "boolean",
      currentValue: true,
    });
  });

  test("falls back to a select when boolean support is not advertised", async () => {
    const runtime = new FakeRuntime();
    const agent = new RemoteAgentAcpAgent(connection([]), runtime, testConfig());
    await initialize(agent, false);
    const response = await agent.resumeSession({
      sessionId: "runtime-1",
      cwd: "/repo",
      mcpServers: [],
    });
    expect(response.configOptions?.at(-1)).toMatchObject({
      id: "fast_mode",
      type: "select",
      currentValue: "default",
    });
  });

  test("replays load history and restores context usage after setup", async () => {
    const runtime = new FakeRuntime();
    runtime.historyMessages = [
      { role: "user", text: "hello" },
      { role: "agent", text: "hi" },
    ];
    const updates: acp.SessionNotification[] = [];
    const agent = new RemoteAgentAcpAgent(
      connection(updates),
      runtime,
      testConfig(),
    );
    await initialize(agent);
    await agent.loadSession({
      sessionId: "runtime-1",
      cwd: "/repo",
      mcpServers: [],
    });
    await Bun.sleep(0);
    expect(updates.map((entry) => entry.update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_message_chunk",
      "usage_update",
    ]);
    expect(updates.at(-1)?.update).toMatchObject({
      sessionUpdate: "usage_update",
      used: 25_000,
      size: 100_000,
    });
  });

  test("streams normalized updates and complete agent config changes", async () => {
    const runtime = new FakeRuntime();
    const changed = baseSession().configOptions.map((option) =>
      option.category === "thought_level" && option.type === "select"
        ? { ...option, id: "effort:changed", currentValue: "high" }
        : option,
    );
    runtime.turnEvents = [
      {
        kind: "update",
        id: "one",
        sessionId: "runtime-1",
        requestId: "request-1",
        createdAt: 1,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "done" },
        },
      },
      {
        kind: "update",
        id: "two",
        sessionId: "runtime-1",
        requestId: "request-1",
        createdAt: 2,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: changed,
        },
      },
      {
        kind: "update",
        id: "three",
        sessionId: "runtime-1",
        requestId: "request-1",
        createdAt: 3,
        update: { sessionUpdate: "usage_update", used: 40_000, size: 100_000 },
      },
    ];
    const updates: acp.SessionNotification[] = [];
    const agent = new RemoteAgentAcpAgent(
      connection(updates),
      runtime,
      testConfig(),
    );
    await initialize(agent);
    expect(
      await agent.prompt({
        sessionId: "runtime-1",
        prompt: [{ type: "text", text: "continue" }],
      }),
    ).toEqual({ stopReason: "end_turn" });
    expect(updates[1]?.update).toMatchObject({
      sessionUpdate: "config_option_update",
      configOptions: [
        { id: "harness" },
        { id: "model" },
        { id: "reasoning_effort", currentValue: "high" },
        { id: "fast_mode", type: "boolean" },
      ],
    });
    expect(updates[2]?.update).toMatchObject({
      sessionUpdate: "usage_update",
      used: 40_000,
      size: 100_000,
    });
  });

  test("a fresh ACP transport loads the same logical session", async () => {
    const runtime = new FakeRuntime();
    const first = new RemoteAgentAcpAgent(connection([]), runtime, testConfig());
    await initialize(first);
    await first.resumeSession({
      sessionId: "runtime-1",
      cwd: "/repo",
      mcpServers: [],
    });
    const second = new RemoteAgentAcpAgent(connection([]), runtime, testConfig());
    await initialize(second);
    const resumed = await second.resumeSession({
      sessionId: "runtime-1",
      cwd: "/repo",
      mcpServers: [],
    });
    expect(resumed._meta).toMatchObject({
      remoteAgentSessionId: "runtime-1",
      acpxRecordId: "record-1",
    });
    expect(runtime.ensures).toHaveLength(0);
  });
});
