import { legacyClerkCreationCommand } from "../apps/server/services/tasks/clerk-creation-recipe.ts";

/** Disposable structured Acpx records matching the original tool/result shape. */
export function clerkCreationRecord(input: { actor: { id: string; acpxRecordId: string; acpxSessionId: string; cwd: string }; taskId: string; environment: string; instanceId: string; email: string;
  resource: { id: string; key: string; kind: string; purpose: string; externalId: string; metadata: unknown }; resourceCreatedAt: string }) {
  const command = legacyClerkCreationCommand(input.environment);
  const createInput = { command, description: "Create exact synthetic test user" };
  const registerInput = { key: input.resource.key, kind: input.resource.kind, purpose: input.resource.purpose, externalId: input.resource.externalId, state: "ready", metadata: input.resource.metadata };
  const tool = (id: string, name: string, value: unknown) => ({ id, name, raw_input: JSON.stringify(value), input: value, is_input_complete: true, thought_signature: null });
  const create = tool("create-exact-user", command, createInput), register = tool("register-exact-user", "mcp__remote-agent__register_resource", registerInput);
  const output = `${JSON.stringify({ kid: input.instanceId, keys: 1 })}\n${JSON.stringify({ userId: input.resource.externalId, email: input.email, created: true })}\n`;
  const registration = [{ type: "text", text: JSON.stringify({ resource: { ...input.resource, taskId: input.taskId, state: "ready", expiresAt: null, createdAt: input.resourceCreatedAt, updatedAt: input.resourceCreatedAt } }) }];
  return { schema: "acpx.session.v1", acpx_record_id: input.actor.acpxRecordId, acp_session_id: input.actor.acpxSessionId, name: input.actor.id, cwd: input.actor.cwd,
    messages: [{ Agent: { content: [{ ToolUse: create }, { ToolUse: register }], tool_results: {
      [create.id]: { tool_use_id: create.id, tool_name: create.name, is_error: false, content: { Text: output }, output },
      [register.id]: { tool_use_id: register.id, tool_name: register.name, is_error: false, content: { Text: JSON.stringify(registration) }, output: registration },
    } } }] };
}
