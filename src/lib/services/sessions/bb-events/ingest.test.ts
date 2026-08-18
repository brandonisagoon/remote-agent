import { describe, expect, test } from "bun:test";

import { bbEventRetryDelayMs } from "./ingest.ts";

describe("bb event ingestion retry", () => {
  test("backs off repeated projection failures and caps the delay", () => {
    expect(bbEventRetryDelayMs(1)).toBe(5_000);
    expect(bbEventRetryDelayMs(2)).toBe(10_000);
    expect(bbEventRetryDelayMs(6)).toBe(160_000);
    expect(bbEventRetryDelayMs(20)).toBe(300_000);
  });
});
