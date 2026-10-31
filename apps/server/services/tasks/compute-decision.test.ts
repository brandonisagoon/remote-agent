import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { classifyCompute, ComputeDecisionEvidence } from "./compute-decision.ts";

const evidence = (): ComputeDecisionEvidence => ({
  version: 1,
  task: { id: "task", primarySessionId: "primary", environmentId: "environment", purpose: "development", revision: "a".repeat(40) },
  observedAt: 1_000_000, evidenceDigest: "b".repeat(64),
  traffic: { coverage: "complete", lastMeaningfulAt: 0, lastUnknownAt: null, inFlight: 0, activeStreams: 0, quietForMs: 1_000_000, collectorAgeMs: 100 },
  activity: { ownedSessionsSettled: true, operationsComplete: true, pendingInstructions: 0, ownerPaused: false, reviewProtected: false, latestInstructionAt: 0 },
  conversation: [{ role: "user", text: "I will return to the saved work later." }],
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
      expect(sent.questions[0].choices.map((x: { value: string }) => x.value)).toEqual(["leave-running", "suspend-compute", "eligible-for-authorized-closure", "insufficient-evidence"]);
      expect(body).not.toContain("private-key");
      return Response.json(answer());
    } });
    expect(result).toEqual({ choice: "suspend-compute", confidence: 0.93, model: "gpt-6-luna", requested: true, evidenceDigest: input.evidenceDigest, requestDigest: createHash("sha256").update(body).digest("hex") });
    expect(input).toEqual(evidence());
  });

  test.each(["leave-running", "eligible-for-authorized-closure", "insufficient-evidence"])("preserves the advisory %s choice without running an effect", async choice => {
    const result = await classifyCompute(evidence(), { apiKey: "test", fetch: async () => Response.json(answer(choice)) });
    expect(result.choice).toBe(choice);
    expect(result.failure).toBeUndefined();
  });

  test.each([
    { answers: [] },
    { answers: [answer().answers[0], answer().answers[0]] },
    answer("delete-everything"),
    answer("suspend-compute", 1.1),
    answer("suspend-compute", -0.1),
    { answers: [{ ...answer().answers[0], name: "other_task" }] },
    { answers: [{ type: "predicate", name: "compute_action", probability: 1 }] },
  ])("rejects missing, duplicate, foreign or out-of-contract answers", async value => {
    const result = await classifyCompute(evidence(), { apiKey: "test", fetch: async () => Response.json(value) });
    expect(result.choice).toBe("insufficient-evidence");
    expect(result.confidence).toBe(0);
    expect(result.failure).toBe("invalid-response");
  });

  test("a refusal is not an instruction to stop", async () => {
    const result = await classifyCompute(evidence(), { apiKey: "test", fetch: async () => Response.json({ answers: [{ type: "refusal", name: "compute_action" }] }) });
    expect(result.choice).toBe("insufficient-evidence");
    expect(result.failure).toBe("refused");
  });

  test("missing credentials never call the API", async () => {
    let calls = 0;
    const result = await classifyCompute(evidence(), { apiKey: " ", fetch: async () => { calls++; return Response.json(answer()); } });
    expect(calls).toBe(0);
    expect(result).toMatchObject({ choice: "insufficient-evidence", requested: false, failure: "missing-credential" });
  });

  test("HTTP errors and transport exceptions never copy diagnostics or secrets into the result", async () => {
    for (const fetcher of [async () => new Response("secret-response", { status: 401 }), async () => { throw new Error("secret-key secret-response"); }]) {
      const result = await classifyCompute(evidence(), { apiKey: "secret-key", fetch: fetcher });
      expect(result.choice).toBe("insufficient-evidence");
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
    expect(result).toMatchObject({ choice: "insufficient-evidence", failure: "timeout" });
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
      await expect(classifyCompute(value as ComputeDecisionEvidence, { apiKey: "test", fetch: async () => { calls++; return Response.json(answer()); } })).rejects.toThrow("Compute decision evidence");
    }
    expect(calls).toBe(0);
  });

  test("evidence changes change the request binding", async () => {
    const first = await classifyCompute(evidence(), { apiKey: "test", fetch: async () => Response.json(answer()) });
    const changed = { ...evidence(), traffic: { ...evidence().traffic, activeStreams: 1 } };
    const next = await classifyCompute(changed, { apiKey: "test", fetch: async () => Response.json(answer("leave-running")) });
    expect(next.requestDigest).not.toBe(first.requestDigest);
    expect(next.choice).toBe("leave-running");
  });
});
