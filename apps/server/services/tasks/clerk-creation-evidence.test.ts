import { expect, test } from "bun:test";
import { originalClerkToolEvidence, originalClerkEnvironment } from "./clerk-creation-evidence.ts";
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
test("actual historical output trailers and frozen Compose/export association need no directory record", () => {
  const f = fixture(), output = f.record.messages[0]!.Agent.tool_results["create-exact-user"]!;
  if (typeof output.output !== "string") throw new Error("Expected the creation command's text result");
  output.output += `-rw-------@ 1 owner  staff  451 Oct 28 14:44 clerk-jwt.pem\n-rw-------@ 1 owner  staff  162 Oct 28 14:44 clerk-user.json\nShell cwd was reset to ${f.input.actor.cwd}\n`;
  output.content.Text = output.output;
  expect(originalClerkToolEvidence(f.record, f.input)).toBeDefined();
  const resources = [
    { id: "old-group", key: "compose-development", kind: "docker-compose-project", purpose: "development", externalId: "drafted-originaltask-development", state: "released", metadata: { envDirectory: "old" } },
    { id: "group", key: "compose-development-r2", kind: "docker-compose-project", purpose: "development", externalId: "drafted-originaltask-development", state: "ready", metadata: { envDirectory: f.input.environment, composeFile: f.input.environment + "/compose.yml" } },
    { id: "export", key: "credentials-export-development", kind: "private-file", purpose: "development", externalId: f.input.environment + "/provider.src.env", state: "ready" },
  ];
  const active = { task: { id: f.input.taskId }, operation: { binding: { resources } } } as any;
  expect(originalClerkEnvironment(active)).toBe(f.input.environment);
  for (const change of ["group", "config", "export", "duplicate", "foreign", "released"] as const) {
    const changed = structuredClone(active), list = changed.operation.binding.resources;
    if (change === "group") list[1].externalId = "drafted-other-development";
    if (change === "config") list[1].metadata.composeFile += ".other";
    if (change === "export") list[2].externalId += ".other";
    if (change === "duplicate") list.push(structuredClone(list[1]));
    if (change === "foreign") list[1].metadata.envDirectory = "/private/environments/foreign";
    if (change === "released") list[1].state = "released";
    expect(() => originalClerkEnvironment(changed)).toThrow();
  }
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
