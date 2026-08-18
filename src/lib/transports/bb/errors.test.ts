import { describe, expect, test } from "bun:test";

import {
  BbTransportError,
  mapBbErrorToDispatchStatus,
} from "./errors.ts";

describe("mapBbErrorToDispatchStatus", () => {
  test("distinguishes missing and rejected targets", () => {
    expect(
      mapBbErrorToDispatchStatus(new BbTransportError("gone", "not_found")),
    ).toBe("stale_target");
    expect(
      mapBbErrorToDispatchStatus(new BbTransportError("busy", "rejected")),
    ).toBe("rejected");
  });

  test("keeps transport failures generic", () => {
    expect(
      mapBbErrorToDispatchStatus(
        new BbTransportError("offline", "unavailable"),
      ),
    ).toBe("failed");
  });
});
