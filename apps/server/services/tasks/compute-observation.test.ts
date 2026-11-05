import { expect, test } from "bun:test";
import { ComputeObservation, sanitizeComputeConversation, compactComputeConversation } from "./compute-observation.ts";
test("review observations cannot add mutable development source evidence", () => {
  const value = { version: 1, environmentId: "environment", taskId: "task", primarySessionId: "primary", purpose: "review", revision: "a".repeat(40), sourceRevision: "b".repeat(40),
    recipeDigest: "c".repeat(64), resourceId: "resource", resourceIdentity: "d".repeat(64), observedAt: Date.now(), state: "running", coverage: "incomplete", configurationDigest: "e".repeat(64), routes: [], operations: { coverage: "incomplete", active: 0, generation: "f".repeat(64) } };
  expect(ComputeObservation.safeParse(value).success).toBe(false);
  expect(ComputeObservation.safeParse({ ...value, sourceRevision: undefined }).success).toBe(true);
});
test("standalone and inline credential-shaped values are removed before Decisions input", () => {
  const standalone = "sk-proj-" + "synthetic".repeat(8), inline = "sk-" + "example".repeat(8), known = "opaque_fixture_credential_123";
  const value = sanitizeComputeConversation([{ role: "user", text: `${standalone}\nUse this ${inline} for development. Keep the app stopped.\n${known}` }], [known]);
  const output = JSON.stringify(value);
  expect(output.includes(standalone) || output.includes(inline) || output.includes(known)).toBe(false);
  expect(output).toContain("Keep the app stopped");
});
test("bounded conversation keeps owner intent while omitting code, private URLs and secret lines", () => {
  const values = sanitizeComputeConversation(Array.from({ length: 40 }, () => ({ role: "agent" as const, text: "Resume when new work arrives.\n```json\n{private:true}\n```\nhttps://private.invalid/path?credential=redacted\npassword=synthetic" })));
  expect(values.length).toBe(32); expect(JSON.stringify(values)).not.toMatch(/private.invalid|private:true|password=|synthetic/);
  expect(values.every(value => value.text.length <= 4000)).toBe(true);
});
test("opaque configured credentials crossing the output bound are redacted before truncation", () => {
  const opaque = "opaque-" + "fixture".repeat(12);
  const result = sanitizeComputeConversation([{ role: "user", text: "a".repeat(3980) + opaque + " trailing" }], [opaque]);
  expect(result[0]!.text).not.toContain(opaque.slice(0,12)); expect(result[0]!.text.length).toBeLessThanOrEqual(4000);
  const repeated = sanitizeComputeConversation([{ role: "user", text: ("a1b2c3d4 ").repeat(1000) }], ["a1b2c3d4"]);
  expect(repeated[0]!.text.length).toBeLessThanOrEqual(4000); expect(repeated[0]!.text).not.toContain("a1b2c3d4");
});


test("compact context keeps ordered conflicting controls and task tail while shrinking bootstrap text", () => {
  const held = "Keep the original app running until the owner releases the hold.";
  const released = "The owner released the hold; finish this turn and retain the saved work.";
  const bootstrap = "Tool preparation details.\n".repeat(300) + held + "\n" + "More setup details.\n".repeat(300) + "Actual task: preserve this app for later useful work.";
  const source = [{ role: "user" as const, text: bootstrap }, { role: "agent" as const, text: "The app is retained and running." }, { role: "user" as const, text: released }];
  const result = compactComputeConversation(source);
  expect(result.conversation.map(value => value.role)).toEqual(["user", "assistant", "user"]);
  expect(result.conversation[0]!.text).toContain(held);
  expect(result.conversation[0]!.text).toContain("Actual task:");
  expect(result.conversation[2]!.text).toBe(released);
  expect(result.conversation[0]!.text.length).toBeLessThanOrEqual(700);
  expect(result.truncations[0]).toMatchObject({ index: 0, omittedControlLines: 0 });
  expect(result.truncations[0]!.omittedCharacters).toBeGreaterThan(0);
});

test("compact context discloses bounded history omissions and redacts before taking literal excerpts", () => {
  const secret = "fixture-private-value-do-not-send";
  const messages = Array.from({ length: 40 }, (_, index) => ({ role: "user" as const, text: index === 12 ? "Keep running for the owner's ongoing review." : `message ${index}` }));
  messages[39]!.text = "Details.\n".repeat(600) + secret + "\nRelease the earlier hold after review; the saved data stays available.";
  const result = compactComputeConversation(messages, [secret]);
  expect(result).toMatchObject({ totalMessages: 40, windowMessages: 32, omittedMessages: 8 });
  expect(result.messageIndexes).toEqual(Array.from({ length: 32 }, (_, index) => index + 8));
  expect(result.conversation.some(value => value.text.includes("Keep running for the owner's ongoing review"))).toBe(true);
  expect(result.conversation.at(-1)!.text).toContain("Release the earlier hold");
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(16_000);
});
