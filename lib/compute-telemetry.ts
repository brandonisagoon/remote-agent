import { z } from "zod";

const Key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,179}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Ownership is registered from exact runtime receipts, never inferred from a
 * hostname, port or user-provided HTTP header. No URLs or request values cross
 * the telemetry wire. */
export const ComputeRoute = z.object({
  id: Key, taskId: Key, primarySessionId: Key, environmentId: Key,
  resourceId: Key, resourceIdentity: Digest, purpose: z.enum(["development", "review"]),
  service: Key, revision: z.string().regex(/^[a-f0-9]{40}$/),
  proxyId: Key, configurationDigest: Digest,
}).strict();
export type ComputeRoute = z.infer<typeof ComputeRoute>;
export const TrafficClass = z.enum(["meaningful", "health", "polling", "hot-reload", "tooling-probe", "unknown"]);
const Request = z.object({ requestId: Key });
export const TrafficEvent = z.discriminatedUnion("kind", [
  Request.extend({ kind: z.literal("start"), classification: TrafficClass }).strict(),
  Request.extend({ kind: z.literal("stream") }).strict(),
  Request.extend({ kind: z.literal("end"), status: z.number().int().min(100).max(599),
    durationMs: Time, cancelled: z.boolean() }).strict(),
  // NGINX completion corroborates the lifecycle accounting; it cannot replace
  // start/end evidence or establish that active streams are absent.
  Request.extend({ kind: z.literal("access"), status: z.number().int().min(100).max(599), durationMs: Time }).strict(),
  z.object({ kind: z.literal("heartbeat") }).strict(),
  z.object({ kind: z.literal("gap"), reason: z.enum(["restart", "overflow", "bypass", "collector-failure", "configuration-change"]) }).strict(),
]);
export const TrafficEnvelope = z.object({
  version: z.literal(1), routeId: Key, epoch: Key, sequence: z.number().int().positive(),
  observedAt: Time, event: TrafficEvent,
}).strict();
export type TrafficEnvelope = z.infer<typeof TrafficEnvelope>;

type Active = { classification: z.infer<typeof TrafficClass>; startedAt: number; stream: boolean };
type Completed = { endedAt: number; status: number; access: boolean };
type Bucket = { minute: number; requests: number; meaningful: number; unknown: number; failed: number; cancelled: number };
export type TrafficState = {
  version: 1; route: ComputeRoute; epoch: string; sequence: number; lastReceivedAt: number;
  lastObservedAt: number; coverage: "complete" | "incomplete"; coverageSince: number;
  reason: string | null; lastMeaningfulAt: number | null; lastUnknownAt: number | null;
  active: Record<string, Active>; completed: Record<string, Completed>; buckets: Bucket[];
};
const MAX_REQUESTS = 4096, MAX_BUCKETS = 60;
const own = (value: object, key: string) => Object.hasOwn(value, key);

/** The caller must independently verify this exact NGINX/configuration and
 * upstream coverage before selecting complete. A new collector alone cannot
 * erase unknown in-flight requests left by its predecessor. */
export function beginTraffic(route: ComputeRoute, epoch: string, at: number, verifiedCoverage = false): TrafficState {
  ComputeRoute.parse(route); Key.parse(epoch); Time.parse(at);
  return { version: 1, route: structuredClone(route), epoch, sequence: 0, lastReceivedAt: at,
    lastObservedAt: at, coverage: verifiedCoverage ? "complete" : "incomplete", coverageSince: at,
    reason: verifiedCoverage ? null : "coverage-unverified", lastMeaningfulAt: null, lastUnknownAt: null,
    active: {}, completed: {}, buckets: [] };
}
function invalidate(state: TrafficState, reason: string) { state.coverage = "incomplete"; state.reason = reason; }

/** Pure reducer used inside the durable collector transaction. A duplicate
 * sequence is ignored; an unknown/gapped sequence permanently invalidates this
 * epoch. Only a separately verified new route generation can restore coverage. */
export function applyTraffic(previous: TrafficState, raw: unknown, receivedAt: number): TrafficState {
  const input = TrafficEnvelope.parse(raw); Time.parse(receivedAt);
  const state = structuredClone(previous), event = input.event;
  if (input.routeId !== state.route.id || input.epoch !== state.epoch) throw new Error("Traffic ownership or collector generation changed");
  if (input.sequence <= state.sequence) return state;
  if (input.sequence !== state.sequence + 1) invalidate(state, "sequence-gap");
  if (input.observedAt < state.lastObservedAt || input.observedAt > receivedAt + 1000) invalidate(state, "collector-clock");
  if (receivedAt < state.lastReceivedAt) throw new Error("Collector receive time moved backwards");
  state.sequence = input.sequence; state.lastReceivedAt = receivedAt;
  state.lastObservedAt = Math.max(state.lastObservedAt, input.observedAt);
  const minute = Math.floor(receivedAt / 60_000);
  state.buckets = state.buckets.filter(bucket => bucket.minute > minute - MAX_BUCKETS);
  for (const [id, completed] of Object.entries(state.completed)) if (receivedAt - completed.endedAt > 60_000) {
    if (!completed.access) invalidate(state, "missing-nginx-completion");
    delete state.completed[id];
  }
  function bucket() {
    let value = state.buckets.find(value => value.minute === minute);
    if (!value) { value = { minute, requests: 0, meaningful: 0, unknown: 0, failed: 0, cancelled: 0 }; state.buckets.push(value); }
    return value;
  }
  if (event.kind === "gap") invalidate(state, event.reason);
  else if (event.kind === "start") {
    if (own(state.active, event.requestId) || own(state.completed, event.requestId)) invalidate(state, "duplicate-request");
    else if (Object.keys(state.active).length + Object.keys(state.completed).length >= MAX_REQUESTS) invalidate(state, "overflow");
    else {
      Object.defineProperty(state.active, event.requestId, { value: { classification: event.classification, startedAt: receivedAt, stream: false }, enumerable: true, configurable: true, writable: true });
      const counts = bucket(); counts.requests++;
      if (event.classification === "meaningful") { counts.meaningful++; state.lastMeaningfulAt = receivedAt; }
      if (event.classification === "unknown") { counts.unknown++; state.lastUnknownAt = receivedAt; }
    }
  } else if (event.kind === "stream") {
    if (!own(state.active, event.requestId)) invalidate(state, "stream-without-start");
    else state.active[event.requestId]!.stream = true;
  } else if (event.kind === "end") {
    const active = own(state.active, event.requestId) ? state.active[event.requestId] : undefined;
    if (!active) invalidate(state, "end-without-start");
    else {
      if (active.classification === "meaningful") state.lastMeaningfulAt = receivedAt;
      if (active.classification === "unknown") state.lastUnknownAt = receivedAt;
      if (event.status >= 400) bucket().failed++;
      if (event.cancelled) bucket().cancelled++;
      delete state.active[event.requestId];
      Object.defineProperty(state.completed, event.requestId, { value: { endedAt: receivedAt, status: event.status, access: false }, enumerable: true, configurable: true, writable: true });
    }
  } else if (event.kind === "access") {
    const ended = own(state.completed, event.requestId) ? state.completed[event.requestId] : undefined;
    if (!ended || ended.status !== event.status || ended.access) invalidate(state, "unmatched-nginx-completion");
    else ended.access = true;
  }
  return state;
}

/** Only metadata and bounded counters go to Decisions, never request IDs,
 * paths, queries, headers, bodies, cookies or credentials. */
export function trafficSummary(state: TrafficState, now: number, freshnessMs: number, quietMs: number) {
  if (![now, freshnessMs, quietMs].every(Number.isSafeInteger) || freshnessMs <= 0 || quietMs <= 0) throw new Error("Invalid traffic policy");
  const active = Object.values(state.active), recent = state.buckets.filter(bucket => bucket.minute > Math.floor(now / 60_000) - MAX_BUCKETS);
  const stale = now < state.lastReceivedAt || now - state.lastReceivedAt > freshnessMs;
  const unmatched = Object.values(state.completed).some(value => !value.access);
  const coverage = !stale && !unmatched && state.coverage === "complete" ? "complete" : "incomplete";
  const application = active.filter(value => !["health", "polling", "hot-reload", "tooling-probe"].includes(value.classification));
  const quiet = coverage === "complete" && application.length === 0 && now - state.coverageSince >= quietMs
    && (state.lastMeaningfulAt === null || now - state.lastMeaningfulAt >= quietMs)
    && (state.lastUnknownAt === null || now - state.lastUnknownAt >= quietMs);
  return { route: state.route, epoch: state.epoch, sequence: state.sequence, observedAt: state.lastReceivedAt,
    coverage, reason: stale ? "collector-stale" : unmatched ? "missing-nginx-completion" : state.reason,
    coverageSince: state.coverageSince, lastMeaningfulAt: state.lastMeaningfulAt, lastUnknownAt: state.lastUnknownAt,
    inFlight: application.length, activeStreams: application.filter(value => value.stream).length,
    backgroundConnections: active.length - application.length,
    recent: recent.reduce((a, b) => ({ requests: a.requests + b.requests, meaningful: a.meaningful + b.meaningful, unknown: a.unknown + b.unknown, failed: a.failed + b.failed, cancelled: a.cancelled + b.cancelled }), { requests: 0, meaningful: 0, unknown: 0, failed: 0, cancelled: 0 }),
    candidate: quiet };
}

const ActiveSchema = z.object({ classification: TrafficClass, startedAt: Time, stream: z.boolean() }).strict();
const CompletedSchema = z.object({ endedAt: Time, status: z.number().int().min(100).max(599), access: z.boolean() }).strict();
const boundedMap = <T extends z.ZodType>(item: T) => z.record(Key, item).refine(value => Object.keys(value).length <= MAX_REQUESTS, "Traffic state exceeds its bound");
export const TrafficStateSchema = z.object({
  version: z.literal(1), route: ComputeRoute, epoch: Key, sequence: z.number().int().nonnegative(), lastReceivedAt: Time,
  lastObservedAt: Time, coverage: z.enum(["complete", "incomplete"]), coverageSince: Time,
  reason: z.string().max(100).nullable(), lastMeaningfulAt: Time.nullable(), lastUnknownAt: Time.nullable(),
  active: boundedMap(ActiveSchema), completed: boundedMap(CompletedSchema),
  buckets: z.array(z.object({ minute: Time, requests: Time, meaningful: Time, unknown: Time, failed: Time, cancelled: Time }).strict()).max(MAX_BUCKETS),
}).strict();
