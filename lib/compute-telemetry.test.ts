import { expect, test } from "bun:test";
import { applyTraffic, beginTraffic, ComputeRoute, TrafficEnvelope, trafficSummary, type TrafficState } from "./compute-telemetry.ts";

const route = ComputeRoute.parse({ id: "route-a", taskId: "task-a", primarySessionId: "primary-a", environmentId: "environment-a", resourceId: "runtime-a",
  resourceIdentity: "a".repeat(64), purpose: "development", service: "web", revision: "a".repeat(40), proxyId: "proxy-a", configurationDigest: "b".repeat(64) });
const start = 1_000_000;
function event(state: TrafficState, value: unknown, at = start + state.sequence + 1, sequence = state.sequence + 1) {
  return applyTraffic(state, { version: 1, routeId: route.id, epoch: state.epoch, sequence, observedAt: at, event: value }, at);
}
function summary(state: TrafficState, now = start + 100_000) { return trafficSummary(state, now, 150_000, 60_000); }
function completed(state: TrafficState, classification: string, status = 200, at = start + 1) {
  state = event(state, { kind: "start", requestId: "request", classification }, at);
  state = event(state, { kind: "end", requestId: "request", status, durationMs: 1, cancelled: false }, at + 1);
  return event(state, { kind: "access", requestId: "request", status, durationMs: 2 }, at + 2);
}

test("coverage is unknown until independently established; heartbeats alone never establish it", () => {
  let state = beginTraffic(route, "epoch-a", start);
  state = event(state, { kind: "heartbeat" }, start + 100_000);
  expect(summary(state)).toMatchObject({ coverage: "incomplete", candidate: false, reason: "coverage-unverified" });
  expect(summary(beginTraffic(route, "epoch-a", start, true))).toMatchObject({ coverage: "complete", candidate: true });
});
test("an in-flight generation stream stays active before NGINX has a completion entry", () => {
  let state = beginTraffic(route, "epoch-a", start, true);
  state = event(state, { kind: "start", requestId: "generation", classification: "meaningful" });
  state = event(state, { kind: "stream", requestId: "generation" });
  expect(summary(state)).toMatchObject({ candidate: false, inFlight: 1, activeStreams: 1 });
  state = event(state, { kind: "heartbeat" }, start + 1_000_000);
  expect(summary(state, start + 1_000_000)).toMatchObject({ candidate: false, inFlight: 1, activeStreams: 1 });
});
test("failed attempted application requests count as meaningful use", () => {
  const state = completed(beginTraffic(route, "epoch-a", start, true), "meaningful", 503, start + 80_000);
  expect(summary(state)).toMatchObject({ candidate: false, recent: { requests: 1, meaningful: 1, failed: 1 } });
});
for (const classification of ["health", "polling", "hot-reload", "tooling-probe"]) test(`known ${classification} traffic does not invent meaningful usage`, () => {
  const state = completed(beginTraffic(route, "epoch-a", start, true), classification, 200, start + 80_000);
  expect(summary(state)).toMatchObject({ candidate: true, lastMeaningfulAt: null, recent: { requests: 1, meaningful: 0 } });
});
test("unknown traffic protects active requests and remains explicit evidence after completion", () => {
  let state = beginTraffic(route, "epoch-a", start, true);
  state = event(state, { kind: "start", requestId: "unknown", classification: "unknown" }, start + 80_000);
  expect(summary(state)).toMatchObject({ candidate: false, inFlight: 1, lastUnknownAt: start + 80_000 });
  state = event(state, { kind: "end", requestId: "unknown", status: 404, durationMs: 1, cancelled: false }, start + 80_001);
  state = event(state, { kind: "access", requestId: "unknown", status: 404, durationMs: 1 }, start + 80_002);
  expect(summary(state)).toMatchObject({ candidate: false, inFlight: 0, recent: { unknown: 1 } });
});
test("disconnect closes one recorded request; completion logging cannot forge a missing start", () => {
  let state = event(beginTraffic(route, "epoch-a", start, true), { kind: "start", requestId: "stream", classification: "meaningful" });
  state = event(state, { kind: "stream", requestId: "stream" });
  state = event(state, { kind: "end", requestId: "stream", status: 499, durationMs: 1, cancelled: true });
  state = event(state, { kind: "access", requestId: "stream", status: 499, durationMs: 2 });
  expect(summary(state)).toMatchObject({ activeStreams: 0, inFlight: 0, recent: { cancelled: 1 } });
  state = event(state, { kind: "access", requestId: "unseen", status: 200, durationMs: 1 });
  expect(summary(state)).toMatchObject({ candidate: false, coverage: "incomplete" });
});
test("sequence loss, collector failure and stale heartbeats never become zero use", () => {
  let state = beginTraffic(route, "epoch-a", start, true);
  state = event(state, { kind: "heartbeat" }, start + 1, 2);
  expect(summary(state)).toMatchObject({ coverage: "incomplete", candidate: false, reason: "sequence-gap" });
  state = event(state, { kind: "heartbeat" }, start + 100_000);
  expect(summary(state)).toMatchObject({ coverage: "incomplete", candidate: false });
  expect(summary(beginTraffic(route, "epoch-a", start, true), start + 200_000)).toMatchObject({ coverage: "incomplete", candidate: false, reason: "collector-stale" });
});
test("restart and reused ports cannot replace the original route generation", () => {
  const state = beginTraffic(route, "epoch-a", start, true);
  expect(() => applyTraffic(state, { version: 1, routeId: route.id, epoch: "replacement", sequence: 1, observedAt: start, event: { kind: "heartbeat" } }, start)).toThrow("generation changed");
  expect(summary(beginTraffic({ ...route, id: "route-b", resourceIdentity: "c".repeat(64) }, "replacement", start))).toMatchObject({ coverage: "incomplete", candidate: false });
});
test("event wire rejects private request content and summaries contain only bounded metadata", () => {
  const base = { version: 1, routeId: route.id, epoch: "epoch-a", sequence: 1, observedAt: start, event: { kind: "start", requestId: "private-id", classification: "meaningful" } };
  for (const field of ["body", "url", "query", "headers", "cookies", "authorization"]) expect(TrafficEnvelope.safeParse({ ...base, event: { ...base.event, [field]: "private" } }).success).toBe(false);
  const state = applyTraffic(beginTraffic(route, "epoch-a", start, true), base, start);
  expect(JSON.stringify(summary(state))).not.toContain("private-id");
});
test("duplicate delivery leaves counters unchanged and bounded replay state survives serialization", () => {
  const initial = beginTraffic(route, "epoch-a", start, true);
  const state = event(initial, { kind: "start", requestId: "constructor", classification: "meaningful" });
  const saved = JSON.parse(JSON.stringify(state));
  expect(summary(saved).inFlight).toBe(1);
  expect(event(saved, { kind: "start", requestId: "constructor", classification: "meaningful" }, start + 1, 1)).toEqual(saved);
});
