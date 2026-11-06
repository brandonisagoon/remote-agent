/**
 * DRA-37 test-only synthetic compute-decision transport, loaded into the
 * isolated Remote Agent SERVER process only (`bun --preload <this file>
 * apps/server/server.ts`). The server's real collector, evidence, idle
 * attempt reservation, decision receipt, runtime-suspended intent and
 * retained-consumer continuation run unchanged; only the one external HTTP
 * decision request is answered here, from the exact request it sends.
 *
 * Intercepted: exactly `POST https://api.openai.com/v1/decisions` with the
 * scripted synthetic bearer credential, redirect "error", JSON body with the
 * exact decision request keys (model gpt-6-luna, `input` = evidence JSON, one
 * `compute_action` choice question). Nothing is forwarded; no real model
 * request is made. EVERY other non-loopback outbound host is refused (thrown
 * and logged), never forwarded with any credential. Unix-socket and loopback
 * requests are unchanged.
 *
 * Answer policy (conservative):
 * - `suspend-compute` (confidence 0.9) ONLY when the runner has armed this
 *   exact environment (decision-arm.json) and has not consumed the arm, AND
 *   the request's own evidence proves idle: development purpose, complete
 *   fresh traffic coverage, quiet for at least the configured quiet period,
 *   no in-flight/active/unknown requests or streams, complete operation
 *   coverage with none active, owned sessions settled, no pending
 *   instructions, not owner-paused or review-protected.
 * - `leave-running` otherwise (including every request before arming or
 *   after the single armed suspension).
 *
 * Files in DRA37_DECISION_DIRECTORY:
 *   decision-state.json     scripted synthetic credential (read-only here)
 *   decision-arm.json       { environmentId } written by the runner to arm
 *   decision-consumed.json  written once when the armed suspension is answered
 *   decision-requests.jsonl every request: timing, request schema/digest,
 *                           evidence facts, idle proof and answered choice
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

const directory = process.env.DRA37_DECISION_DIRECTORY;
if (!directory || !path.isAbsolute(directory)) throw new Error("The DRA-37 synthetic decision preload requires an absolute DRA37_DECISION_DIRECTORY");
const State = z.strictObject({ apiKey: z.string().regex(/^synthetic-not-a-credential-[0-9a-f-]{36}$/) });
const state = State.parse(JSON.parse(readFileSync(path.join(directory, "decision-state.json"), "utf8")));
const requestLog = path.join(directory, "decision-requests.jsonl");
const armFile = path.join(directory, "decision-arm.json"), consumedFile = path.join(directory, "decision-consumed.json");
const log = (value: object) => appendFileSync(requestLog, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...value }) + "\n", { mode: 0o600 });
const ENDPOINT = "https://api.openai.com/v1/decisions";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const Choice = z.strictObject({ value: z.enum(["leave-running", "suspend-compute", "eligible-for-authorized-closure"]), description: z.string().min(1) });
const Body = z.strictObject({ model: z.literal("gpt-6-luna"), input: z.string().min(2).max(65_536),
  questions: z.array(z.strictObject({ type: z.literal("choice"), name: z.literal("compute_action"), instructions: z.string().min(1), choices: z.array(Choice).length(3) })).length(1) });
// Only the facts this transport needs; the server's own schema is authoritative.
const Evidence = z.object({ version: z.literal(2),
  task: z.object({ id: z.string(), environmentId: z.string(), purpose: z.enum(["development", "review"]) }),
  observedAt: z.number(), evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  policy: z.object({ quietPeriodSeconds: z.number(), collectorFreshnessSeconds: z.number() }),
  traffic: z.object({ coverage: z.enum(["complete", "incomplete"]), lastMeaningfulAt: z.number().nullable(), inFlight: z.number(), activeStreams: z.number(), quietForMs: z.number(), collectorAgeMs: z.number() }),
  measurement: z.object({ unknownInFlight: z.number(), lastUnknownAgeMs: z.number().nullable(), coverageForMs: z.number(), operations: z.object({ coverage: z.enum(["complete", "incomplete"]), active: z.number() }) }),
  activity: z.object({ ownedSessionsSettled: z.boolean(), operationsComplete: z.boolean(), pendingInstructions: z.number(), ownerPaused: z.boolean(), reviewProtected: z.boolean() }) });

function idleProof(evidence: z.infer<typeof Evidence>) {
  const quietMs = evidence.policy.quietPeriodSeconds * 1000, freshMs = evidence.policy.collectorFreshnessSeconds * 1000;
  const checks = {
    development: evidence.task.purpose === "development",
    completeCoverage: evidence.traffic.coverage === "complete" && evidence.measurement.operations.coverage === "complete",
    fresh: evidence.traffic.collectorAgeMs <= freshMs,
    quietForPeriod: evidence.traffic.quietForMs >= quietMs && evidence.measurement.coverageForMs >= quietMs,
    nothingInFlight: evidence.traffic.inFlight === 0 && evidence.traffic.activeStreams === 0 && evidence.measurement.unknownInFlight === 0,
    noRecentUnknown: evidence.measurement.lastUnknownAgeMs === null || evidence.measurement.lastUnknownAgeMs >= quietMs,
    noActiveOperations: evidence.measurement.operations.active === 0 && evidence.activity.operationsComplete,
    sessionsSettled: evidence.activity.ownedSessionsSettled && evidence.activity.pendingInstructions === 0,
    notPausedOrProtected: !evidence.activity.ownerPaused && !evidence.activity.reviewProtected,
  };
  return { idle: Object.values(checks).every(Boolean), checks };
}

const original = globalThis.fetch;
const synthetic = async (input: string | URL | Request, init?: RequestInit) => {
  const unix = Boolean(init && (init as { unix?: string }).unix);
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (unix || LOOPBACK.has(url.hostname)) return original(input as Parameters<typeof fetch>[0], init);
  const receivedAt = Date.now();
  const refuse = (reason: string): never => {
    log({ outcome: "refused", reason, method: request.method, origin: url.origin, path: url.pathname });
    throw new TypeError(`DRA-37 synthetic decision transport refused ${reason}`);
  };
  if (url.href !== ENDPOINT) refuse("unexpected outbound external host or path");
  if (request.method !== "POST") refuse("non-POST decision request");
  if (request.headers.get("authorization") !== `Bearer ${state.apiKey}`) refuse("unexpected credential");
  if (request.redirect !== "error") refuse("redirects must be refused by the caller");
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) refuse("non-JSON decision request");
  const text = await request.text();
  const body = Body.safeParse((() => { try { return JSON.parse(text); } catch { return null; } })());
  if (!body.success) return refuse("unexpected decision request schema");
  const parsedEvidence = Evidence.safeParse((() => { try { return JSON.parse(body.data.input); } catch { return null; } })());
  if (!parsedEvidence.success) return refuse("unexpected decision evidence schema");
  const evidence = parsedEvidence.data, proof = idleProof(evidence);
  const arm = existsSync(armFile) ? z.strictObject({ environmentId: z.string() }).parse(JSON.parse(readFileSync(armFile, "utf8"))) : null;
  const armed = arm?.environmentId === evidence.task.environmentId && !existsSync(consumedFile);
  const choice = armed && proof.idle ? "suspend-compute" as const : "leave-running" as const;
  if (choice === "suspend-compute") writeFileSync(consumedFile, JSON.stringify({ environmentId: evidence.task.environmentId, evidenceDigest: evidence.evidenceDigest, at: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
  const response = { answers: [{ type: "choice" as const, name: "compute_action" as const, choice, confidence: choice === "suspend-compute" ? 0.9 : 0.6 }] };
  log({ outcome: "answered", receivedAt, respondedAt: Date.now(), requestDigest: createHash("sha256").update(text).digest("hex"),
    requestSchema: { keys: Object.keys(JSON.parse(text)).sort(), model: body.data.model, question: body.data.questions[0]!.name, choices: body.data.questions[0]!.choices.map(value => value.value) },
    evidence: { environmentId: evidence.task.environmentId, taskId: evidence.task.id, evidenceDigest: evidence.evidenceDigest, observedAt: evidence.observedAt, policy: evidence.policy,
      traffic: evidence.traffic, measurement: evidence.measurement, activity: evidence.activity },
    armed, idleProof: proof, response });
  return Response.json(response);
};
globalThis.fetch = Object.assign(synthetic, { preconnect: original.preconnect }) as typeof fetch;
log({ outcome: "loaded", argv: process.argv.slice(1, 3) });
