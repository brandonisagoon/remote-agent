#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";

interface RoutingContext {
  candidates: Array<{ agentIssueIdentifier: string }>;
  comment?: string;
  replyTargets?: Array<{ commentId: string }>;
}

const args = process.argv.slice(2);
const schemaFile = optionValue("--output-schema");
const outputFile = optionValue("--output-last-message");
const configs = repeatedOptionValues("--config");
const schema = JSON.parse(readFileSync(schemaFile, "utf8")) as unknown;

if (
  optionValue("--model", false) === "fake-invalid-schema" ||
  hasKeyword(schema, "uniqueItems")
) {
  failInvalidSchema();
}

const command = JSON.parse(
  configValue(configs, "mcp_servers.linear_session.command="),
) as string;
const serverArgs = JSON.parse(
  configValue(configs, "mcp_servers.linear_session.args="),
) as string[];
const envConfig = configValue(
  configs,
  "mcp_servers.linear_session.env=",
);
const contextMatch = envConfig.match(
  /^\{REMOTE_AGENT_ROUTING_CONTEXT_FILE=(.+)\}$/,
);
if (!contextMatch) {
  throw new Error("Missing routing-context environment config");
}
const contextFile = JSON.parse(contextMatch[1]!) as string;

const child = Bun.spawn([command, ...serverArgs], {
  env: {
    ...process.env,
    REMOTE_AGENT_ROUTING_CONTEXT_FILE: contextFile,
  },
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});
child.stdin.write(
  [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_routing_context", arguments: {} },
    }),
  ].join("\n") + "\n",
);
child.stdin.end();

const [exitCode, stdout, stderr] = await Promise.all([
  child.exited,
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
]);
if (exitCode !== 0) {
  throw new Error(`Routing MCP exited ${exitCode}: ${stderr}`);
}

const responses = stdout
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const toolResponse = responses.find((response) => response.id === 2);
const context = toolResponse?.result?.structuredContent as
  | RoutingContext
  | undefined;
const candidate = context?.candidates[0];
if (!candidate) {
  throw new Error("Routing MCP returned no candidates");
}

const replyTarget = context.replyTargets?.[0];
const comment = context.comment?.toLowerCase() ?? "";
const expectedActions: string[] = [];

if (!comment.includes("fyi")) {
  if (comment.includes("plan")) expectedActions.push("plan_update");
  if (comment.includes("implement") || comment.includes("ship")) {
    expectedActions.push("code_change");
  }
  if (expectedActions.length === 0 && replyTarget) {
    expectedActions.push("reply");
  }
}

writeFileSync(
  outputFile,
  JSON.stringify({
    targetAgentIssueIdentifier: candidate.agentIssueIdentifier,
    reasonCode: "primary_session",
    confidence: 1,
    expectedActions,
    replyToCommentId: expectedActions.includes("reply")
      ? replyTarget?.commentId ?? null
      : null,
  }),
);

function optionValue(name: string, required = true): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value !== undefined) return value;
  if (!required) return "";
  throw new Error(`Missing ${name}`);
}

function repeatedOptionValues(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) {
      values.push(args[index + 1]!);
    }
  }
  return values;
}

function configValue(configs: string[], prefix: string): string {
  const entry = configs.find((value) => value.startsWith(prefix));
  if (!entry) throw new Error(`Missing config ${prefix}`);
  return entry.slice(prefix.length);
}

function hasKeyword(value: unknown, keyword: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasKeyword(item, keyword));
  }
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) => key === keyword || hasKeyword(child, keyword),
  );
}

function failInvalidSchema(): never {
  process.stderr.write("Codex router startup banner\n".repeat(30));
  process.stderr.write(
    [
      "invalid_request_error",
      "code: invalid_json_schema",
      "Invalid schema for response_format 'codex_output_schema':",
      "In context=('properties', 'expectedActions'), 'uniqueItems' is not permitted.",
      "param: text.format.schema",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
