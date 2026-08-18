import { describe, expect, test } from "bun:test";

import type { BbEvent } from "../types/runtime/index.ts";
import { projectEventToAcp } from "./projection.ts";

function event(type: string, data: unknown): BbEvent {
  return {
    id: `evt-${type}`,
    threadId: "thr_1",
    seq: 1,
    createdAt: 1,
    type,
    scope: { kind: "thread" },
    data,
  };
}

describe("ACP event projection", () => {
  test("projects user, agent, thought, and command events", () => {
    expect(
      projectEventToAcp(
        event("client/turn/requested", {
          input: [{ type: "text", text: "hi" }],
        }),
      ),
    ).toEqual([
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } },
    ]);
    expect(
      projectEventToAcp(
        event("item/completed", { item: { type: "agentMessage", text: "hello" } }),
      ),
    ).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
    ]);
    expect(
      projectEventToAcp(event("item/reasoning/textDelta", { delta: "thinking" })),
    ).toEqual([
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } },
    ]);
    expect(
      projectEventToAcp(
        event("item/started", {
          item: { type: "commandExecution", id: "call-1", command: "bun test", cwd: "/repo" },
        }),
      )[0],
    ).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      kind: "execute",
    });
  });

  test("drops unknown and token-only events", () => {
    expect(projectEventToAcp(event("thread/tokenUsage/updated", {}))).toEqual([]);
    expect(projectEventToAcp(event("item/agentMessage/delta", { delta: "partial" }))).toEqual([]);
  });

  test("pairs MCP tool starts and completions without orphan updates", () => {
    expect(
      projectEventToAcp(event("item/started", {
        item: {
          type: "toolCall",
          id: "call-linear",
          server: "linear",
          tool: "get_issue",
          arguments: { id: "CUBE-1" },
          status: "pending",
        },
      })),
    ).toEqual([{
      sessionUpdate: "tool_call",
      toolCallId: "call-linear",
      title: "linear.get_issue",
      kind: "other",
      status: "in_progress",
      rawInput: { id: "CUBE-1" },
    }]);
    expect(
      projectEventToAcp(event("item/completed", {
        item: { type: "toolCall", id: "call-linear", status: "completed" },
      })),
    ).toMatchObject([{
      sessionUpdate: "tool_call_update",
      toolCallId: "call-linear",
      status: "completed",
    }]);
    expect(
      projectEventToAcp(event("item/completed", {
        item: { type: "reasoning", id: "reasoning-1", status: "completed" },
      })),
    ).toEqual([]);
  });
});
