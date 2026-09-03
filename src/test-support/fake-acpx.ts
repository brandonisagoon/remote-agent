#!/usr/bin/env bun
/** Emulates `acpx <harness> exec` for router tests: reads the routing context
    and output schema from the prompt and prints a decision (quiet format). */

interface RoutingContext {
  candidates: Array<{ agentIssueIdentifier: string }>;
  comment?: string;
  replyTargets?: Array<{ commentId: string }>;
}

const args = process.argv.slice(2);
const promptText = args[args.length - 1] ?? "";

function optionValue(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function block(tag: string): string {
  const match = promptText.match(new RegExp(`<${tag}>\\n(.*?)\\n</${tag}>`, "s"));
  if (!match) throw new Error(`Missing <${tag}> block in prompt`);
  return match[1]!;
}

function hasKeyword(value: unknown, keyword: string): boolean {
  if (Array.isArray(value)) return value.some((item) => hasKeyword(item, keyword));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) => key === keyword || hasKeyword(child, keyword),
  );
}

const schema = JSON.parse(block("output-schema")) as unknown;
if (optionValue("--model") === "fake-invalid-schema" || hasKeyword(schema, "uniqueItems")) {
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

const context = JSON.parse(block("routing-context")) as RoutingContext;
const candidate = context.candidates[0];
if (!candidate) throw new Error("Routing context has no candidates");

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

console.log(
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
