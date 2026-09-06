import { describe, expect, test } from "bun:test";

import { enqueueAgentIssueWrite } from "./index.ts";

describe("enqueueAgentIssueWrite", () => {
  test("queues writes for the same session", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = enqueueAgentIssueWrite("same", async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
    });
    const second = enqueueAgentIssueWrite("same", async () => {
      order.push("second:start");
      order.push("second:end");
    });

    await Bun.sleep(1);
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  test("allows different sessions to write concurrently", async () => {
    const active = new Set<string>();
    let overlapped = false;

    await Promise.all(
      ["a", "b"].map((key) =>
        enqueueAgentIssueWrite(key, async () => {
          active.add(key);
          if (active.size === 2) overlapped = true;
          await Bun.sleep(2);
          active.delete(key);
        }),
      ),
    );

    expect(overlapped).toBeTrue();
  });
});
