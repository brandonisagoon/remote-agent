import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, type PrismaClient, type ComputeBaseline, type RemoteTask } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { cleanupFamily } from "./closed-cleanup.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";
import { CleanupObserverError, cleanupObserverReasons } from "./cleanup-observer-diagnostics.ts";

export const countedComputeKinds = ["native-app", "launch-agent", "launch-agents", "task-runtime", "docker-container", "docker-compose-project"];
const Purpose = z.enum(["development", "review"]);
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Ids = z.array(z.string().min(1)).min(1).max(1000).refine(ids => new Set(ids).size === ids.length);
export const ComputeBaselineObservation = z.object({
  version: z.literal(1), kind: z.literal("compute-baseline"), machineId: z.string().min(1), taskId: z.string().min(1),
  primarySessionId: z.string().min(1), purpose: Purpose, resourceSetDigest: Sha, observedAt: z.number().int().nonnegative(),
  resources: z.array(z.object({ resourceId: z.string().min(1), resourceIdentity: Sha,
    state: z.enum(["running", "stopped", "absent", "unknown"]), proofDigest: Sha }).strict()).min(1).max(1000),
}).strict();
const Proof = z.object({ snapshotDigest: Sha, observation: ComputeBaselineObservation }).strict();
type Runtime = Pick<AgentSessionRuntime, "observeSessionActivity">;
type Store = Prisma.TransactionClient;
type Context = { prisma: PrismaClient; config: ServerConfig; runtime: Runtime; now?: Date };
type Read = (input: Context, task: RemoteTask, request: unknown) => Promise<unknown>;
const key = (machineId: string, taskId: string, purpose: string) => finalizationDigest({ machineId, taskId, purpose });

async function snapshot(store: Store, row: ComputeBaseline, runtime: Runtime) {
  const purpose = Purpose.parse(row.purpose), ids = Ids.parse(row.resourceIds);
  if (row.id !== key(row.machineId, row.taskId, purpose)) throw new Error("Compute baseline group identity changed");
  const task = await store.remoteTask.findUniqueOrThrow({ where: { id: row.taskId } });
  if (task.machineId !== row.machineId || !task.primarySessionId || !task.worktreePath) throw new Error("Compute baseline original task is unavailable");
  const primary = await store.runtimeSession.findUniqueOrThrow({ where: { id: task.primarySessionId } });
  if (primary.role !== "primary" || primary.machineId !== task.machineId || primary.repositoryId !== task.repositoryId || primary.cwd !== task.worktreePath) throw new Error("Compute baseline original primary changed");
  const resources = await store.remoteTaskResource.findMany({ where: { taskId: task.id, OR: [
    { purpose, state: { not: "released" }, kind: { in: countedComputeKinds } }, { id: { in: ids } },
  ] }, orderBy: { id: "asc" }, take: 1001 });
  if (!resources.length || resources.length > 1000 || ids.some(id => !resources.some(resource => resource.id === id))
    || resources.some(resource => resource.purpose !== purpose || !countedComputeKinds.includes(resource.kind))) throw new Error("Compute baseline complete member set is unavailable");
  const identities = resources.map(finalizationResourceIdentity);
  // Include historical relations and moved descendants. Owner pause and closure
  // are facts to preserve, never reasons to open or enroll the original task.
  const sessions = (await cleanupFamily(store, task, primary.id)).sort((a, b) => a.id.localeCompare(b.id));
  if (sessions.some(session => session.machineId !== task.machineId || session.repositoryId !== task.repositoryId)) throw new Error("Compute baseline family ownership changed");
  const sessionIds = sessions.map(session => session.id);
  const relations = await store.runtimeSessionRelation.findMany({ where: { relationship: "spawned-by", OR: [
    { sourceSessionId: { in: sessionIds } }, { targetSessionId: { in: sessionIds } },
  ] }, orderBy: { id: "asc" }, take: 4001 });
  const links = await store.runtimeSessionResourceLink.findMany({ where: { runtimeSessionId: { in: sessionIds } }, orderBy: { id: "asc" }, take: 4001 });
  const instructions = await store.runtimeInstruction.findMany({ where: { sessionId: { in: sessionIds }, state: { in: ["queued", "preparing", "dispatching", "unknown"] } }, orderBy: { id: "asc" }, take: 1001 });
  const lifecycle = await Promise.all(sessions.map(session => store.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: session.id }, orderBy: { sequence: "desc" } })));
  if (relations.length > 4000 || links.length > 4000 || instructions.length > 1000) throw new Error("Compute baseline family exceeds its bound");
  const settled = !!runtime.observeSessionActivity && instructions.length === 0 && sessions.every(session => ["idle", "closed"].includes(session.status)
    && !["executing", "queued"].includes(runtime.observeSessionActivity!(session.id).state)
    && (session.closedAt || lifecycle.find(event => event?.runtimeSessionId === session.id)?.phase !== "started"));
  const environments = await store.computeEnvironment.findMany({ where: { machineId: row.machineId, taskId: task.id, purpose }, orderBy: { id: "asc" }, take: 1001 });
  const offers = await store.computeOffer.findMany({ where: { environmentId: { in: environments.map(environment => environment.id) }, state: { in: ["queued", "offered", "validating", "claimed", "running", "unknown"] } }, orderBy: { id: "asc" }, take: 1001 });
  const slots = await store.computeSlot.findMany({ where: { allocationId: { in: offers.map(offer => offer.id) } }, orderBy: { id: "asc" }, take: 1001 });
  // Conservatively bind global physical ownership claims, but not unrelated
  // offers/slots: normal delivery elsewhere must not invalidate all credit.
  const claims = await store.remoteTaskResource.findMany({ where: { task: { machineId: row.machineId }, kind: { in: countedComputeKinds } }, orderBy: { id: "asc" }, take: 10001 });
  if (environments.length > 1000 || offers.length > 1000 || slots.length > 1000 || claims.length > 10000) throw new Error("Compute baseline ownership exceeds its bound");
  const digest = finalizationDigest({ task, primary, resources, sessions, relations, links, instructions, lifecycle, environments, offers, slots,
    claims: claims.map(resource => ({ taskId: resource.taskId, ...finalizationResourceIdentity(resource) })) });
  return { task, primary, resources, identities, resourceSetDigest: finalizationDigest(identities), digest,
    settled: settled && !offers.some(offer => ["claimed", "running", "unknown"].includes(offer.state)) };
}

function matches(observation: z.infer<typeof ComputeBaselineObservation>, row: ComputeBaseline, current: Awaited<ReturnType<typeof snapshot>>, now: Date, freshness: number) {
  return observation.machineId === row.machineId && observation.taskId === row.taskId && observation.primarySessionId === current.primary.id
    && observation.purpose === row.purpose && observation.resourceSetDigest === current.resourceSetDigest
    && observation.observedAt <= now.getTime() && now.getTime() - observation.observedAt <= freshness * 1000
    && observation.resources.length === current.identities.length && new Set(observation.resources.map(resource => resource.resourceId)).size === current.identities.length
    && observation.resources.every(resource => ["stopped", "absent"].includes(resource.state)
      && current.identities.some(identity => identity.id === resource.resourceId && identity.identityDigest === resource.resourceIdentity));
}

/** Durable, non-sensitive outcome of a group's latest COMPLETED refresh: a
 * fixed phase and finite code with the time that state began. Diagnostic only:
 * never proof, never credit, never raw observer/provider output. "proof-recorded"
 * means only that an observation was persisted as the group's proof; credit is
 * decided solely by computeBaselineCredits (stopped, current, fresh). Each
 * record names the refresh (token) that produced it and is written only while
 * that refresh is still the group's current one, so a slower superseded
 * refresh can never append over a newer one. Written only on a change of
 * outcome/phase/code (bounded), outside every proof/credit transaction. */
export const BaselineRefreshPhase = z.enum(["snapshot", "observe", "validate", "credit"]);
const PHASE_CODES = { snapshot: "SNAPSHOT_UNAVAILABLE", observe: "OBSERVER_UNVERIFIED", validate: "OBSERVATION_INVALID", credit: "PROOF_REJECTED" } as const;
export const BaselineRefreshCode = z.enum([...Object.keys(cleanupObserverReasons) as [keyof typeof cleanupObserverReasons, ...Array<keyof typeof cleanupObserverReasons>],
  ...Object.values(PHASE_CODES), "FAMILY_ACTIVE"]);
const RefreshRecord = z.object({ version: z.literal(1), groupId: Sha, refreshToken: z.string().uuid(), outcome: z.enum(["proof-recorded", "failed", "deferred"]),
  phase: BaselineRefreshPhase.optional(), code: BaselineRefreshCode.optional(), since: z.number().int().nonnegative() }).strict();
export type BaselineRefresh = Omit<z.infer<typeof RefreshRecord>, "version" | "groupId" | "refreshToken">;
const REFRESH_ACTION = "compute-baseline-refresh";
const refreshSource = (machineId: string) => `compute-baseline:${machineId}`;
const refreshCode = (phase: z.infer<typeof BaselineRefreshPhase>, error: unknown): z.infer<typeof BaselineRefreshCode> => error instanceof CleanupObserverError ? error.diagnostic.code : PHASE_CODES[phase];
const parseJson = (text: string | null | undefined) => { try { return JSON.parse(text ?? "null"); } catch { return null; } };
async function latestRefresh(store: Pick<Store, "remoteTask" | "runtimeMetadataEvent">, machineId: string, taskId: string, groupId: string) {
  const task = await store.remoteTask.findUnique({ where: { id: taskId }, select: { primarySessionId: true } });
  if (!task?.primarySessionId) return null;
  const where = { runtimeSessionId: task.primarySessionId, source: refreshSource(machineId), action: REFRESH_ACTION, key: groupId };
  const event = await store.runtimeMetadataEvent.findFirst({ where, orderBy: { sequence: "desc" } });
  const parsed = RefreshRecord.safeParse(parseJson(event?.value));
  const record = parsed.success && parsed.data.groupId === groupId ? parsed.data : null;
  return { where, record, unreadable: Boolean(event) && !record };
}
class SupersededRefresh extends Error {}
async function recordRefresh(input: Context, taskId: string, groupId: string, token: string, value: Omit<BaselineRefresh, "since">) {
  try {
    const latest = await latestRefresh(input.prisma, input.config.machine, taskId, groupId);
    if (!latest) return;
    const prior = latest.record;
    if (prior && prior.outcome === value.outcome && prior.phase === value.phase && prior.code === value.code) return;
    const record = RefreshRecord.parse({ version: 1, groupId, refreshToken: token, ...value, since: (input.now ?? new Date()).getTime() });
    // The append (first write, taking the lock) commits only while this
    // refresh is still the group's current one; otherwise it rolls back.
    await input.prisma.$transaction(async tx => {
      await tx.runtimeMetadataEvent.create({ data: { ...latest.where, value: JSON.stringify(record) } });
      const row = await tx.computeBaseline.findUnique({ where: { id: groupId }, select: { refreshToken: true } });
      if (row?.refreshToken !== token) throw new SupersededRefresh();
    });
  } catch { /* Diagnostic only (superseded or unavailable): never affects accounting. */ }
}

const readInstalled: Read = async (input, task, request) => (await import("./compute-observer.ts")).readInstalledComputeBaseline(input, task, request);

/** Accounting only, also usable before policy activation. Each group's proof
 * is invalidated when that group's own refresh begins (before its fallible
 * read), so a long pass never clears unrelated fresh proof. A failure of the
 * host-wide inventory is evidence against every group and invalidates all. */
export async function refreshComputeBaselines(input: Context, read: Read = readInstalled) {
  const machineId = input.config.machine, token = randomUUID();
  let existing: ComputeBaseline[], resources: Awaited<ReturnType<Store["remoteTaskResource"]["findMany"]>>, environments: Awaited<ReturnType<Store["computeEnvironment"]["findMany"]>>;
  try {
    existing = await input.prisma.computeBaseline.findMany({ where: { machineId }, take: 1001 });
    resources = await input.prisma.remoteTaskResource.findMany({ where: { task: { machineId }, purpose: { in: ["development", "review"] }, state: { not: "released" }, kind: { in: countedComputeKinds } }, orderBy: { id: "asc" }, take: 10001 });
    environments = await input.prisma.computeEnvironment.findMany({ where: { machineId }, take: 1001 });
    if (existing.length > 1000 || resources.length > 10000 || environments.length > 1000) throw new Error("Compute baseline inventory exceeds its bound");
  } catch (error) {
    await input.prisma.computeBaseline.updateMany({ where: { machineId }, data: { refreshToken: token, proof: Prisma.DbNull } });
    throw error;
  }
  const groups = new Map(existing.map(row => [row.id, { taskId: row.taskId, purpose: row.purpose, ids: Ids.parse(row.resourceIds) }]));
  for (const resource of resources) {
    const id = key(machineId, resource.taskId, resource.purpose);
    if (!groups.has(id) && !environments.some(environment => environment.resourceId === resource.id)) groups.set(id, { taskId: resource.taskId, purpose: resource.purpose, ids: [] });
  }
  if (groups.size > 1000) throw new Error("Compute baseline group inventory exceeds its bound");
  let observed = 0, unavailable = 0, index = 0;
  const entries = [...groups];
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
    for (;;) {
      const entry = entries[index++]; if (!entry) return;
      const [id, group] = entry;
      let phase: z.infer<typeof BaselineRefreshPhase> = "snapshot";
      try {
        const row = await input.prisma.$transaction(async tx => {
          // Another process may have discovered a member after this inventory,
          // including one already Released again. Retained claims never shrink.
          const current = await tx.computeBaseline.findUnique({ where: { id } });
          const resourceIds = [...new Set([...group.ids, ...(current ? Ids.parse(current.resourceIds) : []),
            ...resources.filter(resource => resource.taskId === group.taskId && resource.purpose === group.purpose).map(resource => resource.id)])].sort();
          Ids.parse(resourceIds);
          return tx.computeBaseline.upsert({ where: { id }, create: { id, machineId, taskId: group.taskId, purpose: group.purpose, resourceIds, refreshToken: token }, update: { resourceIds, refreshToken: token, proof: Prisma.DbNull } });
        });
        const before = await snapshot(input.prisma, row, input.runtime);
        if (!before.settled) { unavailable++; await recordRefresh(input, group.taskId, id, token, { outcome: "deferred", phase: "snapshot", code: "FAMILY_ACTIVE" }); continue; }
        phase = "observe";
        const request = { version: 1, kind: "compute-baseline", machineId, task: { id: before.task.id, primarySessionId: before.primary.id, toolingRevision: before.task.toolingRevision, worktreePath: before.task.worktreePath },
          purpose: group.purpose, resourceSetDigest: before.resourceSetDigest, resources: before.resources.map(resource => ({ ...finalizationResourceIdentity(resource), state: resource.state, metadata: resource.metadata })) };
        const raw = await read(input, before.task, request);
        phase = "validate";
        const observation = ComputeBaselineObservation.parse(raw);
        phase = "credit";
        const credited = await input.prisma.$transaction(async tx => {
          const held = await tx.computeBaseline.findUniqueOrThrow({ where: { id } });
          if (held.refreshToken !== token) return false;
          const current = await snapshot(tx, held, input.runtime);
          if (!current.settled || current.digest !== before.digest || !matches(observation, held, current, input.now ?? new Date(), (input.config.compute ?? ComputePolicy.parse({})).collectorFreshnessSeconds)) return false;
          const saved = await tx.computeBaseline.updateMany({ where: { id, refreshToken: token }, data: { proof: { snapshotDigest: current.digest, observation } } });
          return saved.count === 1;
        });
        // Persisted as proof only; whether it credits (stopped, current, fresh)
        // is decided solely by computeBaselineCredits.
        if (credited) { observed++; await recordRefresh(input, group.taskId, id, token, { outcome: "proof-recorded" }); }
        else { unavailable++; await recordRefresh(input, group.taskId, id, token, { outcome: "failed", phase, code: PHASE_CODES.credit }); }
      } catch (error) { unavailable++; await recordRefresh(input, group.taskId, id, token, { outcome: "failed", phase, code: refreshCode(phase, error) }); }
    }
  }));
  return { observed, unavailable };
}

/** Why a group is not credited; each names the evidence that is missing. */
export type BaselineCreditReason = "missing-proof" | "refresh-failed" | "unobservable" | "inventory-unavailable" | "family-active" | "membership-changed" | "proof-stale" | "not-proven-stopped";
/** Recheck inside the existing admission transaction. A stale/missing cache
 * only retains reservation; it can never turn into an environment or claim. */
export async function computeBaselineCredits(store: Store, input: { machineId: string; policy: ComputePolicy; runtime?: Runtime; now?: Date }) {
  const rows = await store.computeBaseline.findMany({ where: { machineId: input.machineId }, take: 1001 });
  if (rows.length > 1000) throw new Error("Compute baseline inventory exceeds its bound");
  return Promise.all(rows.map(async row => {
    let credited = false, reason: BaselineCreditReason | undefined, observedAt: number | undefined, refresh: BaselineRefresh | undefined, refreshUnreadable = false;
    const proof = Proof.safeParse(row.proof);
    if (!proof.success) {
      // No current proof: the latest recorded refresh distinguishes a failed or
      // deferred observation from one never made. It never credits.
      const read = await latestRefresh(store, row.machineId, row.taskId, row.id).catch(() => null), latest = read?.record;
      if (latest) { const { version: _version, groupId: _group, refreshToken: _token, ...summary } = latest; refresh = summary; }
      else if (read?.unreadable) refreshUnreadable = true;
      reason = latest?.outcome === "failed" ? "refresh-failed" : latest?.outcome === "deferred" ? "family-active" : "missing-proof";
    }
    else if (!input.runtime) { reason = "unobservable"; observedAt = proof.data.observation.observedAt; }
    else {
      observedAt = proof.data.observation.observedAt;
      try {
        const current = await snapshot(store, row, input.runtime), now = input.now ?? new Date();
        const fresh = observedAt <= now.getTime() && now.getTime() - observedAt <= input.policy.collectorFreshnessSeconds * 1000;
        credited = current.settled && current.digest === proof.data.snapshotDigest && matches(proof.data.observation, row, current, now, input.policy.collectorFreshnessSeconds);
        if (!credited) reason = !current.settled ? "family-active" : current.digest !== proof.data.snapshotDigest ? "membership-changed" : !fresh ? "proof-stale" : "not-proven-stopped";
      } catch { reason = "inventory-unavailable"; /* Unknown original claims remain reserved. */ }
    }
    return { taskId: row.taskId, purpose: row.purpose, resourceIds: Ids.parse(row.resourceIds), credited, ...(reason ? { reason } : {}), ...(observedAt === undefined ? {} : { observedAt }), ...(refresh ? { refresh } : {}), ...(refreshUnreadable ? { refreshUnreadable } : {}) };
  }));
}
