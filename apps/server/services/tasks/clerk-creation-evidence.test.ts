import { expect, test } from "bun:test";
import { originalClerkToolEvidence } from "./clerk-creation-evidence.ts";
import { clerkCreationRecord } from "../../../../test-support/clerk-creation-fixture.ts";

function fixture() {
  const input = { actor: { id: "delegate", acpxRecordId: "delegate-record", acpxSessionId: "delegate-provider", cwd: "/original/source", repositoryId: "repository", machineId: "machine",
    relation: { id: "original-spawn", sourceSessionId: "delegate", targetSessionId: "primary", createdAt: "2026-10-28T21:30:00Z" } },
    taskId: "originaltask", environment: "/private/environments/originaltask", instanceId: "ins_Original", email: "dra71.original+clerk_test@example.com", resourceCreatedAt: "2026-10-28T22:10:26.539Z",
    resource: { id: "original-user", key: "clerk-test-user-development", kind: "clerk-test-user", purpose: "development", externalId: "user_Original", state: "ready", expiresAt: null,
      metadata: { instance: "Clerk test instance (sk_test/pk_test guarded), kid ins_Original", email: "dra71.original+clerk_test@example.com", credentialsFile: "<envDirectory>/clerk-user.json (0600)" } } };
  return { input, record: clerkCreationRecord(input) };
}
test("paired original creation and later registration produce only redacted digests", () => {
  const f = fixture(), evidence = originalClerkToolEvidence(f.record, f.input)!;
  expect(evidence.creationCall).toBe("create-exact-user"); expect(evidence.registrationCall).toBe("register-exact-user");
  expect(evidence.creationDigest).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(evidence)).not.toContain(f.input.email);
  f.record.messages.push({ Agent: { content: [], tool_results: {} as any } });
  expect(originalClerkToolEvidence(f.record, f.input)).toEqual(evidence);
});
test.each(["reused", "wrong-user", "wrong-instance", "wrong-email", "failed", "unpaired", "command", "incomplete", "raw-input", "registration-id", "registration-task", "registration-time", "registration-meta", "result-content", "before-create", "duplicate", "wrong-actor", "text-only"])("original creation refuses %s evidence", change => {
  const f = fixture(), agent = f.record.messages[0]!.Agent as any, create = agent.content[0].ToolUse, register = agent.content[1].ToolUse, created = agent.tool_results[create.id], registered = agent.tool_results[register.id];
  if (["reused", "wrong-user", "wrong-instance", "wrong-email"].includes(change)) {
    created.output = created.output.replace(change === "reused" ? '"created":true' : change === "wrong-user" ? "user_Original" : change === "wrong-instance" ? "ins_Original" : f.input.email,
      change === "reused" ? '"created":false' : "wrong"); created.content.Text = created.output;
  }
  if (change === "failed") created.is_error = true;
  if (change === "unpaired") created.tool_use_id = "other";
  if (change === "command") { create.input.command += "; echo created"; create.raw_input = JSON.stringify(create.input); }
  if (change === "incomplete") create.is_input_complete = false;
  if (change === "raw-input") create.raw_input = "{}";
  if (change.startsWith("registration-")) {
    const receipt = JSON.parse(registered.output[0].text); const target = change.slice(13);
    if (target === "meta") receipt.resource.metadata.extra = "changed";
    else receipt.resource[target === "task" ? "taskId" : target === "time" ? "createdAt" : "id"] = "changed";
    registered.output[0].text = JSON.stringify(receipt); registered.content.Text = JSON.stringify(registered.output);
  }
  if (change === "result-content") registered.content.Text = "[]";
  if (change === "before-create") agent.content.reverse();
  if (change === "duplicate") agent.content.push(structuredClone(agent.content[0]));
  if (change === "wrong-actor") f.record.acp_session_id = "other";
  if (change === "text-only") agent.content = [{ Text: created.output }];
  if (change === "text-only") expect(originalClerkToolEvidence(f.record, f.input)).toBeUndefined();
  else expect(() => originalClerkToolEvidence(f.record, f.input)).toThrow();
});
