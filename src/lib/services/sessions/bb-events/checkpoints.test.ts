import { describe, expect, test } from "bun:test";

import type { BbEvent } from "../../../../types/runtime/index.ts";
import { buildBbCheckpointComment } from "./checkpoints.ts";

function event(type: string, data: unknown): BbEvent {
  return {
    id: "evt_9",
    threadId: "thr_1",
    seq: 9,
    createdAt: 9,
    type,
    scope: { kind: "thread" },
    data,
  };
}

describe("bb Linear checkpoints", () => {
  test("posts durable final output without token or tool noise", () => {
    const body = buildBbCheckpointComment(
      event("turn/completed", { status: "completed" }),
      "Implementation is ready.",
    );
    expect(body).toContain("Implementation is ready.");
    expect(body).not.toContain("<!--");
    expect(
      buildBbCheckpointComment(event("thread/tokenUsage/updated", {}), null),
    ).toBeNull();
  });

  test("renders option questions but leaves failures to error notices", () => {
    expect(
      buildBbCheckpointComment(
        event("turn/completed", {
          status: "failed",
          error: { message: "provider disconnected" },
        }),
        null,
      ),
    ).toBeNull();
    const question = buildBbCheckpointComment(
      event("system/userQuestion/lifecycle", {
        status: "pending",
        payload: {
          questions: [
            {
              prompt: "Where should bb run?",
              options: [{ label: "MacBook Air", description: "Always on" }],
            },
          ],
        },
      }),
      null,
    );
    expect(question).toContain("Where should bb run?");
    expect(question).toContain("@agent");
  });
});
