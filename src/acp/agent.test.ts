import { describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";

import { createFakeBbClient } from "../test-support/bb.ts";
import type { BbEvent, BbModel, BbThread } from "../types/runtime/index.ts";
import { BbAcpAgent } from "./agent.ts";

const thread: BbThread = {
  id: "thr_acp",
  projectId: "proj_1",
  environmentId: "env_1",
  hostId: "host_air",
  providerId: "codex",
  title: "ACP test",
  status: "idle",
  parentThreadId: null,
  archivedAt: null,
};

function event(seq: number, type: string, data: unknown): BbEvent {
  return {
    id: `evt_${seq}`,
    threadId: thread.id,
    seq,
    createdAt: seq,
    type,
    scope: { kind: "thread" },
    data,
  };
}

function model(
  id: string,
  efforts: BbModel["supportedReasoningEfforts"],
  isDefault = false,
): BbModel {
  return {
    id,
    model: id,
    displayName: id,
    description: `${id} model`,
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: efforts[0]!.reasoningEffort,
    isDefault,
  };
}

describe("bb ACP agent", () => {
  test("lists, loads, replays, tails, prompts, and cancels one canonical thread", async () => {
    const bb = createFakeBbClient([thread]);
    bb.putEnvironment({
      id: "env_1",
      projectId: "proj_1",
      hostId: "host_air",
      path: "/worktrees/acp-test",
      branchName: "acp-test",
    });
    bb.setModels("codex", [
      model(
        "gpt-test",
        [{ reasoningEffort: "medium", description: "Medium" }],
        true,
      ),
    ]);
    bb.setExecutionOptions(thread.id, {
      model: "gpt-test",
      reasoningLevel: "medium",
      permissionMode: "accept-edits",
      serviceTier: "default",
    });
    bb.pushEvent(
      event(1, "item/started", {
        item: {
          type: "userMessage",
          content: [{ type: "text", text: "first" }],
        },
      }),
    );
    const updates: acp.SessionNotification[] = [];
    const connection = {
      async sessionUpdate(notification: acp.SessionNotification) {
        updates.push(notification);
      },
      async requestPermission() {
        return { outcome: { outcome: "cancelled" as const } };
      },
    } as unknown as acp.AgentSideConnection;
    const agent = new BbAcpAgent(connection, bb, {
      bbBaseUrl: "http://127.0.0.1:38886",
      projectIds: ["proj_1"],
      cwdByProject: { proj_1: "/repo" },
      providerId: "codex",
    });

    const capabilities = (await agent.initialize()).agentCapabilities;
    expect(capabilities?.loadSession).toBe(true);
    expect(capabilities?.sessionCapabilities?.list).toEqual({});
    expect(await agent.listSessions()).toMatchObject({
      sessions: [{ sessionId: "thr_acp", cwd: "/worktrees/acp-test" }],
    });
    expect(await agent.listSessions({ cwd: "/other" })).toEqual({
      sessions: [],
    });
    expect(await agent.listSessions({ cwd: "/repo" })).toEqual({
      sessions: [],
    });
    expect(
      await agent.listSessions({ cwd: "/worktrees/acp-test" }),
    ).toMatchObject({
      sessions: [{ sessionId: "thr_acp" }],
    });
    const loaded = await agent.loadSession({
      sessionId: thread.id,
      cwd: "/repo",
      mcpServers: [],
    });
    expect(loaded._meta).toMatchObject({ cwd: "/worktrees/acp-test" });
    expect(loaded.configOptions).toMatchObject([
      { id: "harness:thr_acp", currentValue: "codex" },
      { id: "model:codex", currentValue: "gpt-test" },
      { id: "mode", currentValue: "accept-edits" },
      { id: "effort:codex:gpt-test", currentValue: "medium" },
      { id: "speed", currentValue: "default" },
    ]);
    expect(updates[0]).toMatchObject({
      sessionId: thread.id,
      update: { sessionUpdate: "user_message_chunk" },
    });

    const prompted = agent.prompt({
      sessionId: thread.id,
      prompt: [{ type: "text", text: "continue" }],
    });
    await Bun.sleep(0);
    bb.pushEvent(
      event(2, "client/turn/requested", {
        input: [{ type: "text", text: "continue" }],
      }),
    );
    bb.pushEvent(
      event(3, "item/completed", {
        item: { type: "agentMessage", text: "done" },
      }),
    );
    bb.pushEvent(event(4, "turn/completed", { status: "completed" }));
    expect(await prompted).toEqual({ stopReason: "end_turn" });
    expect(bb.sentMessages).toEqual([
      {
        threadId: thread.id,
        message: "continue",
        mode: "queue-if-active",
        model: "gpt-test",
        reasoningLevel: "medium",
        permissionMode: "accept-edits",
        serviceTier: "default",
      },
    ]);
    expect(updates.at(-1)).toMatchObject({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { text: "done" },
      },
    });

    await agent.cancel({ sessionId: thread.id });
    expect(bb.stoppedThreadIds).toEqual([thread.id]);
  });

  test("selects harness, model, mode, effort, and speed and restores them on load", async () => {
    const bb = createFakeBbClient([thread]);
    bb.putEnvironment({
      id: "env_1",
      projectId: "proj_1",
      hostId: "host_air",
      path: "/worktrees/acp-test",
      branchName: "acp-test",
    });
    bb.setModels("codex", [
      model("gpt-fast", [{ reasoningEffort: "low", description: "Low" }], true),
      model("gpt-deep", [
        { reasoningEffort: "medium", description: "Medium" },
        { reasoningEffort: "high", description: "High" },
      ]),
    ]);
    bb.setModels("claude-code", [
      model(
        "claude-opus",
        [
          { reasoningEffort: "high", description: "High" },
          { reasoningEffort: "max", description: "Maximum" },
        ],
        true,
      ),
    ]);
    bb.setExecutionOptions(thread.id, {
      model: "gpt-fast",
      reasoningLevel: "low",
      permissionMode: "accept-edits",
      serviceTier: "default",
    });
    const updates: acp.SessionNotification[] = [];
    const connection = {
      async sessionUpdate(notification: acp.SessionNotification) {
        updates.push(notification);
      },
      async requestPermission() {
        return { outcome: { outcome: "cancelled" as const } };
      },
    } as unknown as acp.AgentSideConnection;
    const config = {
      bbBaseUrl: "http://127.0.0.1:38886",
      projectIds: ["proj_1"],
      cwdByProject: { proj_1: "/repo" },
      providerId: "codex" as const,
    };
    const agent = new BbAcpAgent(connection, bb, config);
    await agent.loadSession({
      sessionId: thread.id,
      cwd: "/repo",
      mcpServers: [],
    });

    let response = await agent.setSessionConfigOption({
      sessionId: thread.id,
      configId: "model:codex",
      value: "gpt-deep",
    });
    expect(response.configOptions).toMatchObject([
      { id: "harness:thr_acp", currentValue: "codex" },
      { id: "model:codex", currentValue: "gpt-deep" },
      { id: "mode", currentValue: "accept-edits" },
      { id: "effort:codex:gpt-deep", currentValue: "medium" },
      { id: "speed", currentValue: "default" },
    ]);
    response = await agent.setSessionConfigOption({
      sessionId: thread.id,
      configId: "effort:codex:gpt-deep",
      value: "high",
    });
    expect(response.configOptions[3]).toMatchObject({ currentValue: "high" });
    response = await agent.setSessionConfigOption({
      sessionId: thread.id,
      configId: "speed",
      value: "fast",
    });
    expect(response.configOptions[4]).toMatchObject({
      id: "speed",
      currentValue: "fast",
    });
    await agent.setSessionConfigOption({
      sessionId: thread.id,
      configId: "mode",
      value: "full",
    });
    response = await agent.setSessionConfigOption({
      sessionId: thread.id,
      configId: "harness:thr_acp",
      value: "claude-code",
    });
    expect(response.configOptions).toMatchObject([
      { id: "harness:thr_acp", currentValue: "claude-code" },
      { id: "model:claude-code", currentValue: "claude-opus" },
      { id: "mode", currentValue: "full" },
      { id: "effort:claude-code:claude-opus", currentValue: "high" },
      { id: "speed", currentValue: "fast" },
    ]);
    expect(bb.spawnInputs.at(-1)).toMatchObject({
      providerId: "claude-code",
      model: "claude-opus",
      reasoningLevel: "high",
      permissionMode: "full",
      serviceTier: "fast",
      visibility: "hidden",
      worktreePath: "/worktrees/acp-test",
    });
    expect(bb.spawnInputs.at(-1)?.parentThreadId).toBeUndefined();

    const childId = `thr_fake_2`;
    const prompted = agent.prompt({
      sessionId: thread.id,
      prompt: [{ type: "text", text: "continue with claude" }],
    });
    await Bun.sleep(0);
    bb.pushEvent({
      ...event(1, "client/turn/requested", {
        input: [{ type: "text", text: "continue with claude" }],
      }),
      threadId: childId,
    });
    bb.pushEvent({
      ...event(2, "turn/completed", { status: "completed" }),
      threadId: childId,
    });
    expect(await prompted).toEqual({ stopReason: "end_turn" });
    expect(bb.sentMessages.at(-1)).toEqual({
      threadId: childId,
      message: "continue with claude",
      mode: "queue-if-active",
      model: "claude-opus",
      reasoningLevel: "high",
      permissionMode: "full",
      serviceTier: "fast",
    });

    const reconnected = new BbAcpAgent(connection, bb, config);
    const loaded = await reconnected.loadSession({
      sessionId: thread.id,
      cwd: "/repo",
      mcpServers: [],
    });
    expect(loaded.configOptions).toMatchObject([
      { id: "harness:thr_acp", currentValue: "claude-code" },
      { id: "model:claude-code", currentValue: "claude-opus" },
      { id: "mode", currentValue: "full" },
      { id: "effort:claude-code:claude-opus", currentValue: "high" },
      { id: "speed", currentValue: "fast" },
    ]);
  });
});
