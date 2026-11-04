import { z } from "zod";
import type { Prisma } from "../../../../generated/prisma/client.ts";
import { ComputeSuspensionDecision } from "./compute-decision.ts";
import { ComputeObservation, type computeEvidenceState } from "./compute-observation.ts";
import { finalizationDigest } from "./finalization-resources.ts";

export const IDLE_ATTEMPT_LIMIT = 3;
export const IDLE_FIRST_BACKOFF_MS = 5 * 60_000;
export const IDLE_SECOND_BACKOFF_MS = 15 * 60_000;
export const IDLE_CLAIM_MS = 2 * 60_000;
const action = "compute-idle-attempt", decisionAction = "compute-idle-decision";
const Hash = z.string().regex(/^[a-f0-9]{64}$/), Time = z.number().int().nonnegative();
const State = z.object({ version: z.literal(1), environmentId: z.string(), lifetime: Hash,
  activity: z.object({ meaningfulAt: Time.nullable(), instructionAt: Time.nullable() }).strict(),
  rootKey: z.string().max(180), originalDecisionRevision: z.number().int().positive().optional(),
  attempt: z.number().int().min(1).max(IDLE_ATTEMPT_LIMIT), requestKey: z.string().max(180), snapshotDigest: Hash,
  phase: z.enum(["claimed", "completed", "unknown", "attention"]), claimedAt: Time, expiresAt: Time,
  lastAttemptAt: Time, retryable: z.boolean(), decisionRevision: z.number().int().positive().optional(),
  choice: ComputeSuspensionDecision.shape.result.unwrap().shape.choice.optional(),
  failure: ComputeSuspensionDecision.shape.result.unwrap().shape.failure,
}).strict();
type State = z.infer<typeof State>;
type Evidence = Awaited<ReturnType<typeof computeEvidenceState>>;
type Store = Pick<Prisma.TransactionClient, "runtimeMetadataEvent" | "computeEnvironment" | "computeOffer" | "computeSlot">;
type Input = { prisma: Store; environmentId: string; observed: Evidence; now: number };
export type ComputeIdleClaim = { revision: number; digest: string; requestKey: string };
type Decision = z.infer<typeof ComputeSuspensionDecision>;

const activity = (observed: Evidence) => ({ meaningfulAt: observed.evidence.traffic.lastMeaningfulAt, instructionAt: observed.evidence.activity.latestInstructionAt });
const usedAgain = (before: State["activity"], after: State["activity"]) => (after.meaningfulAt ?? -1) > (before.meaningfulAt ?? -1) || (after.instructionAt ?? -1) > (before.instructionAt ?? -1);
const retryable = (value: Decision) => value.outcome !== "suspension-recorded" && !["missing-credential", "refused"].includes(value.result?.failure ?? "")
  && (value.outcome === "stale" || value.result === null || value.result.choice === "insufficient-evidence");
const backoff = (attempt: number) => attempt >= 2 ? IDLE_SECOND_BACKOFF_MS : IDLE_FIRST_BACKOFF_MS;

async function owner(input: Pick<Input, "prisma" | "environmentId">) {
  const environment = await input.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: input.environmentId } });
  const observation = ComputeObservation.parse(environment.observation);
  const allocations = await input.prisma.computeOffer.findMany({ where: { environmentId: environment.id, state: { in: ["claimed", "running", "unknown"] } }, take: 2 });
  if (allocations.length > 1) throw new Error("Idle allocation ownership is ambiguous");
  const allocation = allocations[0];
  if (allocation) {
    const slot = await input.prisma.computeSlot.findUnique({ where: { allocationId: allocation.id } });
    if (!allocation.claimedAt || allocation.machineId !== environment.machineId || !slot || slot.machineId !== environment.machineId) throw new Error("Idle allocation ownership is unavailable");
  }
  const lifetime = finalizationDigest({ environmentId: environment.id, taskId: environment.taskId, primarySessionId: environment.primarySessionId,
    identity: environment.taskIdentity, revision: environment.revision, recipe: environment.recipeDigest,
    resourceId: environment.resourceId, resourceIdentity: environment.resourceIdentity, configuration: observation.configurationDigest,
    application: observation.application ? { id: observation.application.containerId, startedAt: observation.application.startedAt } : undefined,
    allocationId: allocation?.id });
  return { environment, lifetime, where: { runtimeSessionId: environment.primarySessionId, source: `compute:${environment.taskId}`, action, key: environment.id } };
}

async function load(input: Input) {
  const owned = await owner(input);
  const event = await input.prisma.runtimeMetadataEvent.findFirst({ where: owned.where, orderBy: { sequence: "desc" } });
  if (event?.value) {
    const state = State.parse(JSON.parse(event.value));
    if (state.environmentId !== input.environmentId) throw new Error("Idle attempt belongs to another environment");
    return { ...owned, state, revision: event.sequence };
  }
  // Old decisions are immutable. Seed their already-spent budget once, rather
  // than rewriting the receipt or charging for another initial consideration.
  const history = await input.prisma.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: owned.environment.primarySessionId,
    source: owned.where.source, action: decisionAction, key: { startsWith: "idle:" } }, orderBy: { sequence: "desc" }, take: 1001 });
  if (history.length > 1000) throw new Error("Idle decision history exceeds its bound");
  const decisions = history.flatMap(row => {
    const value = ComputeSuspensionDecision.parse(JSON.parse(row.value!));
    return value.environmentId === input.environmentId ? [{ row, value }] : [];
  });
  const latest = decisions[0];
  if (!latest) return { ...owned, state: undefined, revision: undefined };
  const sameEpisode = decisions.filter(({ value }) => value.evidence.traffic.lastMeaningfulAt === latest.value.evidence.traffic.lastMeaningfulAt
    && value.evidence.activity.latestInstructionAt === latest.value.evidence.activity.latestInstructionAt);
  const lastAttemptAt = Math.max(latest.row.occurredAt.getTime(), latest.value.evidence.observedAt);
  const state = State.parse({ version: 1, environmentId: input.environmentId, lifetime: owned.lifetime,
    activity: { meaningfulAt: latest.value.evidence.traffic.lastMeaningfulAt, instructionAt: latest.value.evidence.activity.latestInstructionAt },
    rootKey: sameEpisode.at(-1)!.value.requestKey, originalDecisionRevision: sameEpisode.at(-1)!.row.sequence,
    attempt: Math.min(IDLE_ATTEMPT_LIMIT, sameEpisode.length), requestKey: latest.value.requestKey, snapshotDigest: latest.value.snapshotDigest,
    phase: "completed", claimedAt: lastAttemptAt, expiresAt: lastAttemptAt, lastAttemptAt, retryable: retryable(latest.value),
    decisionRevision: latest.row.sequence, choice: latest.value.result?.choice, failure: latest.value.result?.failure });
  return { ...owned, state, revision: undefined };
}

function schedule(input: Input, loaded: Awaited<ReturnType<typeof load>>) {
  const previous = loaded.state, freshActivity = activity(input.observed);
  // An uncertain outstanding request is never superseded by a new key or use.
  if (previous?.phase === "claimed") return { status: "pending" as const, due: false, nextEligibleAt: previous.expiresAt, reset: false };
  const reset = !previous || previous.lifetime !== loaded.lifetime || usedAgain(previous.activity, freshActivity);
  const nextEligibleAt = previous ? Math.max(previous.lastAttemptAt + IDLE_FIRST_BACKOFF_MS,
    reset ? 0 : previous.lastAttemptAt + backoff(previous.attempt)) : input.now;
  if (!reset && !previous!.retryable && !previous!.failure) return { status: previous!.choice === "suspend-compute" ? "suspension-recorded" as const : "advisory" as const, due: false, reset, nextEligibleAt: null };
  if (!reset && (!previous!.retryable || previous!.attempt >= IDLE_ATTEMPT_LIMIT)) return { status: "attention" as const, due: false, reset, nextEligibleAt: null };
  if (!input.observed.eligible || input.observed.physicalState !== "running" || input.observed.evidence.task.purpose !== "development") return { status: "blocked" as const, due: false, reset, nextEligibleAt };
  return { status: input.now < nextEligibleAt ? "cooldown" as const : "due" as const, due: input.now >= nextEligibleAt, reset, nextEligibleAt };
}

/** No mutations or model calls. Safe for both the periodic worker and the
 * authenticated task-scoped capacity diagnostic. */
export async function computeIdleAttemptStatus(input: Input) {
  const loaded = await load(input), planned = schedule(input, loaded);
  return { environmentId: input.environmentId, status: planned.status, attempts: planned.reset ? 0 : loaded.state?.attempt ?? 0,
    maxAttempts: IDLE_ATTEMPT_LIMIT, nextEligibleAt: planned.nextEligibleAt,
    originalDecisionRevision: loaded.state?.originalDecisionRevision, lastDecisionRevision: loaded.state?.decisionRevision,
    lastChoice: loaded.state?.choice, failure: loaded.state?.failure };
}

/** Must run in the existing SQLite write transaction, after fresh deterministic
 * evidence was checked. Only a committed winning reservation may call Decisions.
 * A writer conflict is not permission to dispatch outside the transaction. */
export async function reserveComputeIdleAttempt(input: Input): Promise<ComputeIdleClaim | undefined> {
  const loaded = await load(input), previous = loaded.state;
  if (previous?.phase === "claimed" && input.now >= previous.expiresAt) {
    const unknown = State.parse({ ...previous, phase: "unknown", retryable: true, lastAttemptAt: Math.max(previous.expiresAt, input.now) });
    await input.prisma.runtimeMetadataEvent.create({ data: { ...loaded.where, value: JSON.stringify(unknown) } });
    return;
  }
  const planned = schedule(input, loaded);
  if (!planned.due) {
    if (planned.status === "attention" && previous?.phase !== "attention") await input.prisma.runtimeMetadataEvent.create({ data: { ...loaded.where, value: JSON.stringify({ ...previous, phase: "attention" }) } });
    return;
  }
  const attempt = planned.reset ? 1 : previous!.attempt + 1;
  const rootKey = planned.reset ? `idle:${finalizationDigest([loaded.lifetime, activity(input.observed), input.observed.snapshotDigest])}` : previous!.rootKey;
  const requestKey = `${rootKey}:attempt:${attempt}`;
  const state = State.parse({ version: 1, environmentId: input.environmentId, lifetime: loaded.lifetime,
    activity: planned.reset ? activity(input.observed) : previous!.activity, rootKey,
    originalDecisionRevision: planned.reset ? undefined : previous?.originalDecisionRevision,
    attempt, requestKey, snapshotDigest: input.observed.snapshotDigest, phase: "claimed", claimedAt: input.now,
    expiresAt: input.now + IDLE_CLAIM_MS, lastAttemptAt: input.now, retryable: true });
  const saved = await input.prisma.runtimeMetadataEvent.create({ data: { ...loaded.where, value: JSON.stringify(state) } });
  return { revision: saved.sequence, digest: finalizationDigest(state), requestKey };
}

export async function currentComputeIdleClaim(input: Pick<Input, "prisma" | "environmentId" | "now"> & { claim: ComputeIdleClaim; snapshotDigest: string }) {
  const owned = await owner(input), row = await input.prisma.runtimeMetadataEvent.findFirst({ where: owned.where, orderBy: { sequence: "desc" } });
  if (!row?.value || row.sequence !== input.claim.revision) return;
  const state = State.parse(JSON.parse(row.value));
  if (finalizationDigest(state) !== input.claim.digest || state.phase !== "claimed" || state.requestKey !== input.claim.requestKey
    || state.environmentId !== input.environmentId || state.lifetime !== owned.lifetime || state.snapshotDigest !== input.snapshotDigest
    || input.now < state.claimedAt || input.now >= state.expiresAt) return;
  return { ...owned, state };
}

export async function finishComputeIdleAttempt(input: Pick<Input, "prisma" | "environmentId" | "now"> & { claim: ComputeIdleClaim; decision?: Decision & { revision: number } }) {
  const owned = await owner(input), row = await input.prisma.runtimeMetadataEvent.findFirst({ where: owned.where, orderBy: { sequence: "desc" } });
  if (!row?.value || row.sequence !== input.claim.revision) return;
  const previous = State.parse(JSON.parse(row.value));
  if (previous.phase !== "claimed" || finalizationDigest(previous) !== input.claim.digest) throw new Error("Idle attempt receipt changed");
  const value = input.decision, known = value && input.now < previous.expiresAt && input.now >= previous.claimedAt && owned.lifetime === previous.lifetime;
  const state = State.parse({ ...previous, phase: known ? "completed" : "unknown", lastAttemptAt: Math.max(input.now, previous.lastAttemptAt),
    retryable: known ? retryable(value) : true,
    originalDecisionRevision: previous.originalDecisionRevision ?? value?.revision,
    decisionRevision: value?.revision, choice: value?.result?.choice, failure: value?.result?.failure });
  await input.prisma.runtimeMetadataEvent.create({ data: { ...owned.where, value: JSON.stringify(state) } });
}
