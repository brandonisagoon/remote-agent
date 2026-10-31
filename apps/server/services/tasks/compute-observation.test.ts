import { expect, test } from "bun:test";
import { ComputeObservation, sanitizeComputeConversation } from "./compute-observation.ts";
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
