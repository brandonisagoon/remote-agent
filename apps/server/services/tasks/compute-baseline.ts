import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, type PrismaClient, type ComputeBaseline, type RemoteTask } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { cleanupFamily } from "./closed-cleanup.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";

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
  const offers = await store.computeOffer.findMany({ where: { environmentId: { in: environments.map(environment => environment.id) }, state: { in: ["queued", "offered", "claimed", "running", "unknown"] } }, orderBy: { id: "asc" }, take: 1001 });
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

const readInstalled: Read = async (input, task, request) => (await import("./compute-observer.ts")).readInstalledComputeBaseline(input, task, request);

/** Accounting only, also usable before policy activation. Invalidate every old
 * free cache before even the first fallible inventory/adapter read. */
export async function refreshComputeBaselines(input: Context, read: Read = readInstalled) {
  const machineId = input.config.machine, token = randomUUID();
  await input.prisma.computeBaseline.updateMany({ where: { machineId }, data: { refreshToken: token, proof: Prisma.DbNull } });
  const existing = await input.prisma.computeBaseline.findMany({ where: { machineId }, take: 1001 });
  const resources = await input.prisma.remoteTaskResource.findMany({ where: { task: { machineId }, purpose: { in: ["development", "review"] }, state: { not: "released" }, kind: { in: countedComputeKinds } }, orderBy: { id: "asc" }, take: 10001 });
  const environments = await input.prisma.computeEnvironment.findMany({ where: { machineId }, take: 1001 });
  if (existing.length > 1000 || resources.length > 10000 || environments.length > 1000) throw new Error("Compute baseline inventory exceeds its bound");
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
        if (!before.settled) { unavailable++; continue; }
        const request = { version: 1, kind: "compute-baseline", machineId, task: { id: before.task.id, primarySessionId: before.primary.id, toolingRevision: before.task.toolingRevision, worktreePath: before.task.worktreePath },
          purpose: group.purpose, resourceSetDigest: before.resourceSetDigest, resources: before.resources.map(resource => ({ ...finalizationResourceIdentity(resource), state: resource.state, metadata: resource.metadata })) };
        const observation = ComputeBaselineObservation.parse(await read(input, before.task, request));
        const credited = await input.prisma.$transaction(async tx => {
          const held = await tx.computeBaseline.findUniqueOrThrow({ where: { id } });
          if (held.refreshToken !== token) return false;
          const current = await snapshot(tx, held, input.runtime);
          if (!current.settled || current.digest !== before.digest || !matches(observation, held, current, input.now ?? new Date(), (input.config.compute ?? ComputePolicy.parse({})).collectorFreshnessSeconds)) return false;
          const saved = await tx.computeBaseline.updateMany({ where: { id, refreshToken: token }, data: { proof: { snapshotDigest: current.digest, observation } } });
          return saved.count === 1;
        });
        if (credited) observed++; else unavailable++;
      } catch { unavailable++; }
    }
  }));
  return { observed, unavailable };
}

/** Recheck inside the existing admission transaction. A stale/missing cache
 * only retains reservation; it can never turn into an environment or claim. */
export async function computeBaselineCredits(store: Store, input: { machineId: string; policy: ComputePolicy; runtime?: Runtime; now?: Date }) {
  const rows = await store.computeBaseline.findMany({ where: { machineId: input.machineId }, take: 1001 });
  if (rows.length > 1000) throw new Error("Compute baseline inventory exceeds its bound");
  return Promise.all(rows.map(async row => {
    let credited = false;
    try {
      const proof = Proof.parse(row.proof);
      if (input.runtime) {
        const current = await snapshot(store, row, input.runtime);
        credited = current.settled && current.digest === proof.snapshotDigest && matches(proof.observation, row, current, input.now ?? new Date(), input.policy.collectorFreshnessSeconds);
      }
    } catch { /* Unknown original claims remain reserved. */ }
    return { taskId: row.taskId, purpose: row.purpose, resourceIds: Ids.parse(row.resourceIds), credited };
  }));
}
