import { describe, expect, test } from "bun:test";

import type { BbEvent } from "../../../../types/runtime/index.ts";
import {
  buildBbErrorNotice,
  buildRecoveryAppendix,
  buildRepeatAppendix,
  buildSessionRootComment,
  isBbErrorEvent,
  parseFailedTurnErrorMessage,
  parseProviderErrorData,
  parseSystemErrorData,
  RECOVERY_MARKER,
  REPEAT_MARKER,
} from "./error-notices.ts";

const context = {
  threadLink: "https://agents.example.com/session-links/bb/thr_1",
  machine: "macbook-air",
  harness: "claude",
};

function event(
  type: string,
  data: unknown,
  scope: BbEvent["scope"] = { kind: "turn", turnId: "turn_1" },
): BbEvent {
  return {
    id: "evt_1",
    threadId: "thr_1",
    seq: 1,
    createdAt: 1_000,
    type,
    scope,
    data,
  };
}

describe("bb error notices", () => {
  test("parses and renders full provider errors", () => {
    const data = {
      message: "Provider error",
      detail: "API Error: 529 Overloaded.",
      errorInfo: {
        category: "overloaded",
        providerCode: "overloaded_error",
        httpStatusCode: 529,
      },
    };
    expect(parseProviderErrorData(data)).toEqual({
      message: "Provider error",
      detail: "API Error: 529 Overloaded.",
      errorInfo: {
        category: "overloaded",
        providerCode: "overloaded_error",
        httpStatusCode: 529,
      },
      willRetry: null,
    });
    const body = buildBbErrorNotice(event("provider/error", data), context)!;
    expect(body).toContain("❌ bb agent error — overloaded (HTTP 529)");
    expect(body).toContain("> API Error: 529 Overloaded.");
    expect(body).toContain("- Turn: `turn_1`");
    expect(body).toContain("`macbook-air` · Harness: `claude`");
    expect(body).toContain("[Open in bb](https://agents.example.com");
    expect(body).toContain("did not report whether it will retry");
    expect(body).not.toContain("<!--");
  });

  test("renders retry decisions and provider fallbacks", () => {
    expect(
      buildBbErrorNotice(
        event("provider/error", { detail: "temporary", willRetry: true }),
        context,
      ),
    ).toContain("bb will retry this turn automatically");
    expect(
      buildBbErrorNotice(
        event("provider/error", { message: "permanent", willRetry: false }),
        context,
      ),
    ).toContain("operator intervention is likely needed");
    expect(
      buildBbErrorNotice(event("provider/error", {}), context),
    ).toContain("No provider error detail was returned.");
  });

  test("parses and renders system errors with reconnect progress", () => {
    const data = {
      code: "transport_closed",
      detail: "bb connection closed",
      reconnect: { attempt: 2, total: 5 },
    };
    expect(parseSystemErrorData(data)).toMatchObject({
      code: "transport_closed",
      detail: "bb connection closed",
      reconnectAttempt: 2,
      reconnectTotal: 5,
    });
    const body = buildBbErrorNotice(
      event("system/error", data, { kind: "thread" }),
      context,
    )!;
    expect(body).toContain("❌ bb runtime error — transport_closed");
    expect(body).toContain("- Reconnect: attempt 2 of 5");
    expect(body).not.toContain("- Turn:");
  });

  test("renders an unpaired failed turn", () => {
    const failed = event("turn/completed", {
      status: "failed",
      error: { message: "provider disconnected" },
    });
    expect(isBbErrorEvent(failed)).toBeTrue();
    expect(parseFailedTurnErrorMessage(failed.data)).toBe(
      "provider disconnected",
    );
    expect(buildBbErrorNotice(failed, context)).toContain(
      "> provider disconnected",
    );
  });

  test("omits missing provider and model from session roots", () => {
    const body = buildSessionRootComment({
      ...context,
      provider: null,
      model: null,
    });
    expect(body).toContain("● bb agent session");
    expect(body).toContain("`macbook-air` · `claude`");
    expect(body).not.toContain("null");
  });

  test("builds visible recovery and repeat appendices", () => {
    const recovery = buildRecoveryAppendix({
      recoveredAtMs: 93_000,
      errorAt: new Date(1_000),
    });
    expect(recovery).toContain(RECOVERY_MARKER);
    expect(recovery).toContain("1m 32s");
    const repeat = buildRepeatAppendix(
      event("provider/error", {
        detail: "still overloaded",
        errorInfo: { category: "overloaded" },
      }),
      context,
    );
    expect(repeat).toContain(REPEAT_MARKER);
    expect(repeat).toContain("overloaded: still overloaded");
  });
});
