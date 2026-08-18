import { describe, expect, test } from "bun:test";

import type { BbThread } from "../types/runtime/bb.ts";
import { createFakeBbClient } from "./bb.ts";

const thread: BbThread = {
  id: "thr_1",
  projectId: "proj_1",
  environmentId: "env_1",
  hostId: "host_air",
  providerId: "codex",
  title: "Primary",
  status: "idle",
  parentThreadId: null,
  archivedAt: null,
};

describe("createFakeBbClient", () => {
  test("records delivery and exposes ordered pushed events", async () => {
    const client = createFakeBbClient([thread]);
    await client.sendMessage({ threadId: thread.id, message: "hello" });
    expect(client.sentMessages).toEqual([
      { threadId: thread.id, message: "hello", mode: "queue-if-active" },
    ]);

    const controller = new AbortController();
    const received: number[] = [];
    const consume = (async () => {
      for await (const event of client.streamEvents({
        threadId: thread.id,
        signal: controller.signal,
      })) {
        received.push(event.seq);
        if (received.length === 2) controller.abort();
      }
    })();
    for (const seq of [2, 1]) {
      client.pushEvent({
        id: `evt_${seq}`,
        threadId: thread.id,
        seq,
        createdAt: seq,
        type: "test",
        scope: { kind: "thread" },
        data: {},
      });
    }
    await consume;
    expect(received).toEqual([1, 2]);
  });
});
