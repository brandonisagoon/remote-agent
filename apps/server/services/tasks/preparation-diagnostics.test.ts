import { expect, test } from "bun:test";
import { preparationStage, withPreparationDiagnostics, type PreparationDiagnostic } from "./preparation-diagnostics.ts";

test("successful nested work restores the parent before a later parent failure", async () => {
  const events: PreparationDiagnostic[] = [], failure = new Error("delivery failed");
  await expect(withPreparationDiagnostics(async event => { events.push(event); }, () => preparationStage("delivery", async () => {
    await preparationStage("fingerprint", async () => undefined);
    throw failure;
  }))).rejects.toBe(failure);
  expect(events.map(({ elapsedMs: _elapsed, ...event }) => event)).toEqual([
    { stage: "delivery", event: "start", activeStage: "delivery" },
    { stage: "fingerprint", event: "start", activeStage: "fingerprint" },
    { stage: "fingerprint", event: "end", outcome: "succeeded", activeStage: "delivery" },
    { stage: "delivery", event: "end", outcome: "failed", activeStage: null, failedStage: "delivery" },
  ]);
});

test("a propagated nested failure keeps its original stage and never reports success", async () => {
  const events: PreparationDiagnostic[] = [], failure = new Error("changed files");
  await expect(withPreparationDiagnostics(async event => { events.push(event); }, () => preparationStage("verification", () =>
    preparationStage("delivery", () => preparationStage("fingerprint", async () => { throw failure; }))))).rejects.toBe(failure);
  const ended = events.filter(event => event.event === "end");
  expect(ended).toHaveLength(3);
  expect(ended.every(event => event.outcome === "failed" && event.failedStage === "fingerprint")).toBe(true);
});

test("a handled nested failure does not taint a later independent parent failure", async () => {
  const events: PreparationDiagnostic[] = [];
  await expect(withPreparationDiagnostics(async event => { events.push(event); }, () => preparationStage("delivery", async () => {
    await preparationStage("fingerprint", async () => { throw new Error("handled"); }).catch(() => undefined);
    await preparationStage("source", async () => undefined);
    throw new Error("later");
  }))).rejects.toThrow("later");
  expect(events.at(-1)).toMatchObject({ stage: "delivery", outcome: "failed", failedStage: "delivery" });
});
