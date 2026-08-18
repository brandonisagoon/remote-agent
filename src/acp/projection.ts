import type { SessionNotification } from "@agentclientprotocol/sdk";

import type { BbEvent } from "../types/runtime/index.ts";

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function itemData(event: BbEvent) {
  const data = object(event.data);
  return { data, item: object(data?.item) };
}

function inputText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const message = value
    .flatMap((blockValue) => {
      const block = object(blockValue);
      const value = block?.type === "text" && block.visibility !== "agent-only"
        ? text(block.text)
        : null;
      return value ? [value] : [];
    })
    .join("\n")
    .trim();
  return message || null;
}

function isToolItem(item: Record<string, unknown> | null): boolean {
  return item?.type === "commandExecution" ||
    item?.type === "fileChange" ||
    item?.type === "toolCall" ||
    item?.type === "mcpToolCall";
}

export function projectEventToAcp(event: BbEvent): SessionNotification["update"][] {
  const { data, item } = itemData(event);
  if (
    event.type === "item/reasoning/summaryTextDelta" ||
    event.type === "item/reasoning/textDelta" ||
    event.type === "item/plan/delta"
  ) {
    const delta = text(data?.delta);
    return delta
      ? [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: delta } }]
      : [];
  }
  if (event.type === "system/manager/user_message") {
    const value = text(data?.text);
    return value
      ? [{ sessionUpdate: "user_message_chunk", content: { type: "text", text: value } }]
      : [];
  }
  if (event.type === "client/turn/requested") {
    const value = inputText(data?.input);
    return value
      ? [{ sessionUpdate: "user_message_chunk", content: { type: "text", text: value } }]
      : [];
  }
  if (event.type === "item/started") {
    if (item?.type === "userMessage") {
      const chunks = Array.isArray(item.content) ? item.content : [];
      return chunks.flatMap((chunk) => {
        const value = object(chunk);
        return value?.type === "text" &&
            value.visibility !== "agent-only" &&
            text(value.text)
          ? [{
              sessionUpdate: "user_message_chunk" as const,
              content: { type: "text" as const, text: value.text as string },
            }]
          : [];
      });
    }
    const id = text(item?.id);
    if (id && item?.type === "commandExecution") {
      return [{
        sessionUpdate: "tool_call",
        toolCallId: id,
        title: text(item.command) ?? "Command",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: item.command, cwd: item.cwd },
      }];
    }
    if (id && item?.type === "fileChange") {
      return [{
        sessionUpdate: "tool_call",
        toolCallId: id,
        title: "Apply file changes",
        kind: "edit",
        status: "in_progress",
        rawInput: { changes: item.changes },
      }];
    }
    if (id && (item?.type === "toolCall" || item?.type === "mcpToolCall")) {
      const server = text(item.server);
      const tool = text(item.tool) ?? text(item.name);
      return [{
        sessionUpdate: "tool_call",
        toolCallId: id,
        title: [server, tool].filter(Boolean).join(".") || "Tool call",
        kind: "other",
        status: "in_progress",
        rawInput: item.arguments ?? item.input ?? undefined,
      }];
    }
  }
  if (event.type === "item/completed") {
    if (item?.type === "agentMessage" && text(item.text)) {
      return [{
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: item.text as string },
      }];
    }
    const id = text(item?.id);
    if (id && isToolItem(item)) {
      return [{
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status: item?.status === "failed" ? "failed" : "completed",
        rawOutput: item ?? undefined,
      }];
    }
  }
  return [];
}
