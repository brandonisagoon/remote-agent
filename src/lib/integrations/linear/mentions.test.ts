import { describe, expect, test } from "bun:test";

import { mentionsAgent } from "./mentions.ts";

const AGENT_USER_ID = "ac8abcbc-5d47-4c0c-93ca-a1c6df69a60a";
const OPTIONS = { agentUserId: AGENT_USER_ID, agentHandle: "agent" };

/**
 * Verbatim `data.body` from a captured Linear Comment webhook,
 * delivery 48b12d46-310a-42d0-9bc9-7a136cd57d05, captured 2026-07-27.
 *
 * Kept exactly as received. If Linear ever changes the mention encoding, this
 * is the test that should fail first.
 */
const REAL_MENTION_BODY = "@agent this is a test";

describe("mentionsAgent — against the real Linear encoding", () => {
  test("matches the captured production payload", () => {
    expect(mentionsAgent(REAL_MENTION_BODY, OPTIONS)).toBe(true);
  });

  test("the captured body contains no UUID, so the handle branch is load-bearing", () => {
    // Documents why the handle match cannot be dropped in favour of id matching.
    expect(REAL_MENTION_BODY.includes(AGENT_USER_ID)).toBe(false);
    expect(
      mentionsAgent(REAL_MENTION_BODY, { ...OPTIONS, agentHandle: null }),
    ).toBe(false);
  });

  test("matches mid-sentence, not just at the start", () => {
    expect(mentionsAgent("could @agent take a look?", OPTIONS)).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(mentionsAgent("@Agent ping", OPTIONS)).toBe(true);
  });

  test("matches when followed by punctuation", () => {
    expect(mentionsAgent("@agent, please look", OPTIONS)).toBe(true);
  });
});

describe("mentionsAgent — non-matches", () => {
  test("an ordinary comment does not match", () => {
    expect(mentionsAgent("just a normal comment", OPTIONS)).toBe(false);
  });

  test("an empty body does not match", () => {
    expect(mentionsAgent("", OPTIONS)).toBe(false);
  });

  test("a longer handle sharing the prefix does not match", () => {
    // "@agentsmith" must not trip the "@agent" handle.
    expect(mentionsAgent("@agentsmith hello", OPTIONS)).toBe(false);
  });

  test("an email-like string does not match", () => {
    expect(mentionsAgent("mail me at bob@agent.com", OPTIONS)).toBe(false);
  });

  test("a different handle does not match", () => {
    expect(mentionsAgent("@codex please look", OPTIONS)).toBe(false);
  });
});

describe("mentionsAgent — UUID fallback", () => {
  test("matches a body containing the agent's id", () => {
    // Never observed from Linear, but retained for richer encodings.
    expect(
      mentionsAgent(`see @[Agent](https://linear.app/x/profiles/${AGENT_USER_ID})`, {
        ...OPTIONS,
        agentHandle: null,
      }),
    ).toBe(true);
  });
});
