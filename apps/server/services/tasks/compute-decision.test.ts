import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { classifyCompute, ComputeDecisionEvidence, ComputeSuspensionDecision } from "./compute-decision.ts";

const evidence = (): ComputeDecisionEvidence => ({
  version: 2,
  task: { id: "task", primarySessionId: "primary", environmentId: "environment", purpose: "development", revision: "a".repeat(40) },
  observedAt: 1_000_000, evidenceDigest: "b".repeat(64),
  traffic: { coverage: "complete", lastMeaningfulAt: 0, lastUnknownAt: null, inFlight: 0, activeStreams: 0, quietForMs: 1_000_000, collectorAgeMs: 100 },
  activity: { ownedSessionsSettled: true, operationsComplete: true, pendingInstructions: 0, ownerPaused: false, reviewProtected: false, latestInstructionAt: 0 },
  conversation: [{ role: "user", text: "I will return to the saved work later." }],
  policy: { quietPeriodSeconds: 30, collectorFreshnessSeconds: 15 },
  measurement: { unknownInFlight: 0, probeConnections: 0, probeStreams: 0, lastUnknownAgeMs: null, coverageForMs: 1_000_000, operations: { coverage: "complete", active: 0 } },
  thread: { name: "Saved work", issueIdentifier: null, taskPhase: "working", order: "oldest-to-newest", totalMessages: 1, windowMessages: 1, omittedMessages: 0, messageIndexes: [0], truncations: [] },
});
const answer = (choice = "suspend-compute", confidence = 0.93) => ({ answers: [{ type: "choice", name: "compute_action", choice, confidence }] });

describe("compute Decisions boundary", () => {
  test("sends bounded evidence to the existing API, uses fixed choices and binds its recommendation", async () => {
    const input = evidence();
    let body = "";
    const result = await classifyCompute(input, { apiKey: "private-key", fetch: async (url, init) => {
      expect(url).toBe("https://api.openai.com/v1/decisions");
      expect(init.redirect).toBe("error");
      expect(init.credentials).toBe("omit");
      expect(init.headers).toEqual({ authorization: "Bearer private-key", "content-type": "application/json" });
      body = String(init.body);
      const sent = JSON.parse(body);
      expect(sent.model).toBe("gpt-6-luna");
      expect(JSON.parse(sent.input)).toEqual(input);
      expect(sent.questions).toHaveLength(1);
      expect(sent.questions[0].choices.map((x: { value: string }) => x.value)).toEqual(["leave-running", "suspend-compute", "eligible-for-authorized-closure"]);
      expect(body).not.toContain("private-key");
      return Response.json(answer());
    } });
    expect(result).toEqual({ kind: "recommendation", choice: "suspend-compute", confidence: 0.93, model: "gpt-6-luna", requested: true, evidenceDigest: input.evidenceDigest, requestDigest: createHash("sha256").update(body).digest("hex") });
    expect(input).toEqual(evidence());
  });

  test.each(["leave-running", "eligible-for-authorized-closure"])("preserves the advisory %s choice without running an effect", async choice => {
    const result = await classifyCompute(evidence(), { apiKey: "test", fetch: async () => Response.json(answer(choice)) });
    expect(result.choice).toBe(choice);
    expect(result.failure).toBeUndefined();
  });

  test.each([
    { answers: [] },
    { answers: [answer().answers[0], answer().answers[0]] },
    answer("delete-everything"),
    answer("insufficient-evidence"),
    answer("suspend-compute", 1.1),
    answer("suspend-compute", -0.1),
    { answers: [{ ...answer().answers[0], name: "other_task" }] },
    { answers: [{ type: "predicate", name: "compute_action", probability: 1 }] },
  ])("rejects missing, duplicate, foreign or out-of-contract answers", async value => {
    const result = await classifyCompute(evidence(), { apiKey: "test", fetch: async () => Response.json(value) });
    expect(result.kind).toBe("diagnostic"); expect(result).not.toHaveProperty("choice"); expect(result).not.toHaveProperty("confidence");
    expect(result.confidence).toBeUndefined();
    expect(result.failure).toBe("invalid-response");
  });

  test("a refusal is not an instruction to stop", async () => {
    const result = await classifyCompute(evidence(), { apiKey: "test", fetch: async () => Response.json({ answers: [{ type: "refusal", name: "compute_action" }] }) });
    expect(result.kind).toBe("diagnostic"); expect(result).not.toHaveProperty("choice"); expect(result).not.toHaveProperty("confidence");
    expect(result.failure).toBe("refused");
  });

  test("missing credentials never call the API", async () => {
    let calls = 0;
    const result = await classifyCompute(evidence(), { apiKey: " ", fetch: async () => { calls++; return Response.json(answer()); } });
    expect(calls).toBe(0);
    expect(result).toMatchObject({ kind: "diagnostic", requested: false, failure: "missing-credential" });
  });

  test("HTTP errors and transport exceptions never copy diagnostics or secrets into the result", async () => {
    for (const fetcher of [async () => new Response("secret-response", { status: 401 }), async () => { throw new Error("secret-key secret-response"); }]) {
      const result = await classifyCompute(evidence(), { apiKey: "secret-key", fetch: fetcher });
      expect(result.kind).toBe("diagnostic"); expect(result).not.toHaveProperty("choice"); expect(result).not.toHaveProperty("confidence");
      expect(JSON.stringify(result)).not.toContain("secret");
    }
  });

  test("the deadline includes a stalled response body and aborts the request", async () => {
    let signal: AbortSignal | undefined;
    let canceled = false;
    const result = await classifyCompute(evidence(), { apiKey: "test", timeoutMs: 20, fetch: async (_, init) => {
      signal = init.signal ?? undefined;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"answers":')); }, cancel() { canceled = true; } }));
    } });
    expect(result).toMatchObject({ kind: "diagnostic", failure: "timeout" });
    expect(signal?.aborted).toBe(true);
    expect(canceled).toBe(true);
  });

  test("the deadline also bounds a transport which does not honor abort", async () => {
    const result = await classifyCompute(evidence(), { apiKey: "test", timeoutMs: 20, fetch: () => new Promise(() => {}) });
    expect(result.failure).toBe("timeout");
  });

  test("oversized response is canceled and cannot supply a decision", async () => {
    let canceled = false;
    const result = await classifyCompute(evidence(), { apiKey: "test", fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(65_537)); }, cancel() { canceled = true; },
    })) });
    expect(result.failure).toBe("invalid-response");
    expect(canceled).toBe(true);
  });

  test("unknown fields, invalid counts and oversized conversation are rejected before a request", async () => {
    const invalid = [
      { ...evidence(), rawAccessLogs: "private requests" },
      { ...evidence(), traffic: { ...evidence().traffic, inFlight: -1 } },
      { ...evidence(), conversation: [{ role: "user", text: "x".repeat(4_001) }] },
      { ...evidence(), conversation: Array.from({ length: 33 }, () => ({ role: "user", text: "x" })) },
      { ...evidence(), conversation: Array.from({ length: 32 }, () => ({ role: "user", text: "x".repeat(4_000) })) },
    ];
    let calls = 0;
    for (const value of invalid) {
      expect(await classifyCompute(value as ComputeDecisionEvidence, { apiKey: "test", fetch: async () => { calls++; return Response.json(answer()); } })).toMatchObject({ kind: "diagnostic", failure: "invalid-evidence", requested: false });
    }
    expect(calls).toBe(0);
  });

  test("evidence changes change the request binding", async () => {
    const first = await classifyCompute(evidence(), { apiKey: "test", fetch: async () => Response.json(answer()) });
    const changed = { ...evidence(), traffic: { ...evidence().traffic, activeStreams: 1 } };
    const next = await classifyCompute(changed, { apiKey: "test", fetch: async () => Response.json(answer("leave-running")) });
    expect(next.requestDigest).not.toBe(first.requestDigest);
    expect(next).toMatchObject({ kind: "diagnostic", failure: "ineligible-evidence", requested: false });
  });
});

test("v1 is readable history but cannot silently become a new v2 classifier request", async () => {
  const { policy: _policy, measurement: _measurement, thread: _thread, ...common } = evidence();
  const legacy = { ...common, version: 1 as const };
  const receipt = { version: 1, environmentId: legacy.task.environmentId, requestKey: "idle:historical", snapshotDigest: legacy.evidenceDigest,
    evidence: legacy, result: { choice: "insufficient-evidence", confidence: 0.5, model: "gpt-6-luna", evidenceDigest: legacy.evidenceDigest, requestDigest: "c".repeat(64), requested: true }, outcome: "advisory" } as const;
  expect(ComputeSuspensionDecision.parse(receipt)).toEqual(receipt);
  expect(ComputeSuspensionDecision.parse({ ...receipt, evidence: evidence() }).evidence.version).toBe(2);
  let calls = 0;
  expect(await classifyCompute(legacy as unknown as ComputeDecisionEvidence, { apiKey: "fixture", fetch: async () => { calls++; return Response.json(answer()); } })).toMatchObject({ kind: "diagnostic", requested: false, failure: "invalid-evidence", requestDigest: null });
  expect(calls).toBe(0);
});

test("the request carries configured thresholds and separates current unknown facts from historical timestamps", async () => {
  const input = evidence(); input.traffic.lastUnknownAt = 0; input.measurement.lastUnknownAgeMs = input.observedAt;
  let sent: any;
  const first = await classifyCompute(input, { apiKey: "fixture", fetch: async (_url, init) => { sent = JSON.parse(String(init.body)); return Response.json(answer("leave-running", 0.5)); } });
  expect(JSON.parse(sent.input)).toEqual(input);
  expect(JSON.parse(sent.input)).toMatchObject({ version: 2, policy: { quietPeriodSeconds: 30, collectorFreshnessSeconds: 15 }, measurement: { unknownInFlight: 0, operations: { coverage: "complete", active: 0 } } });
  expect(first.choice).toBe("leave-running");
  const changed = await classifyCompute({ ...input, policy: { ...input.policy, quietPeriodSeconds: 120 } }, { apiKey: "fixture", fetch: async () => Response.json(answer("leave-running")) });
  expect(changed.requestDigest).not.toBe(first.requestDigest); expect(changed.evidenceDigest).toBe(first.evidenceDigest);
  expect(changed.model).toBe("gpt-6-luna"); expect(changed.choice).toBe("leave-running");
});


test.each(["stale", "incomplete", "unknown", "recent-unknown", "operation", "pause"])("current %s facts return a server diagnostic without calling the model", async changed => {
  const input = evidence(); let calls = 0;
  if (changed === "stale") input.traffic.collectorAgeMs = input.policy.collectorFreshnessSeconds * 1000 + 1;
  if (changed === "incomplete") input.traffic.coverage = "incomplete";
  if (changed === "unknown") { input.traffic.inFlight = 1; input.measurement.unknownInFlight = 1; }
  if (changed === "recent-unknown") { input.traffic.lastUnknownAt = input.observedAt; input.measurement.lastUnknownAgeMs = 0; }
  if (changed === "operation") input.measurement.operations.active = 1;
  if (changed === "pause") input.activity.ownerPaused = true;
  const result = await classifyCompute(input, { apiKey: "fixture", fetch: async () => { calls++; return Response.json(answer()); } });
  expect(result).toMatchObject({ kind: "diagnostic", failure: "ineligible-evidence", requested: false, requestDigest: null });
  expect(result).not.toHaveProperty("choice"); expect(result).not.toHaveProperty("confidence"); expect(calls).toBe(0);
});

test("an oversized but shaped packet is diagnosed without a fabricated model result", async () => {
  const input = evidence(); input.conversation = Array.from({ length: 32 }, () => ({ role: "user" as const, text: "\ud800".repeat(700) }));
  let calls = 0;
  const result = await classifyCompute(input, { apiKey: "fixture", fetch: async () => { calls++; return Response.json(answer()); } });
  expect(result).toMatchObject({ kind: "diagnostic", failure: "input-too-large", requested: false, requestDigest: null });
  expect(result).not.toHaveProperty("choice"); expect(result).not.toHaveProperty("confidence"); expect(calls).toBe(0);
});
