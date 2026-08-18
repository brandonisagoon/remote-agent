import { describe, expect, test } from "bun:test";

import { matchesReactionEmoji, normalizeReactionEmoji } from "./emoji.ts";

describe("reaction emoji matching", () => {
  test.each([
    ["pencil2", "pencil2"],
    [":pencil2:", "pencil2"],
    [" ✏️ ", "✏"],
  ])("normalizes %s", (value, expected) => {
    expect(normalizeReactionEmoji(value)).toBe(expected);
  });

  test.each(["pencil2", ":pencil2:", "✏️", "✏"])(
    "treats %s as the configured pencil reaction",
    (value) => {
      expect(matchesReactionEmoji(value, "pencil2")).toBe(true);
    },
  );

  test("rejects unrelated emoji", () => {
    expect(matchesReactionEmoji("thumbsup", "pencil2")).toBe(false);
  });
});
