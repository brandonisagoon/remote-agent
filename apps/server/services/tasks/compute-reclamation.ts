import { z } from "zod";
import type { Prisma, PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { cleanupFamily } from "./closed-cleanup.ts";
import { computeTaskIdentity } from "./compute-admission.ts";
import { ComputeObservation } from "./compute-observation.ts";
import { ComputeReclamation } from "./compute-reclamation-schema.ts";
import { isSavedComputeEnvironment } from "./compute-saved-resource.ts";
import { readInstalledComputeReclamation } from "./compute-observer.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";
import { computeFamilyGeneration, computeFamilySettled } from "./compute-family.ts";
import { retainedComputeConfiguration } from "./compute-accounting-input.ts";
import { releasedComputeCleanupFence } from "./compute-cleanup-reclamation.ts";

type Store = Prisma.TransactionClient;
type Context = { prisma: PrismaClient; config: ServerConfig; environmentId: string; runtime: Pick<AgentSessionRuntime, "observeSessionActivity">; now?: Date };
export type ComputeReclamationContext = Context;
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
export async function readComputeReclamationSnapshot(store: Store, input: Context) {
  const environment = await store.computeEnvironment.findUniqueOrThrow({ where: { id: input.environmentId } });
  const task = await store.remoteTask.findUniqueOrThrow({ where: { id: environment.taskId } });
  const primary = await store.runtimeSession.findUniqueOrThrow({ where: { id: environment.primarySessionId } });
  if (environment.machineId !== input.config.machine || task.machineId !== environment.machineId || primary.machineId !== task.machineId
    || task.primarySessionId !== primary.id || primary.role !== "primary" || primary.repositoryId !== task.repositoryId || primary.cwd !== task.worktreePath || !task.worktreePath
    || !environment.resourceId || !environment.resourceIdentity) throw new Error("Compute reclamation original owner changed");
  // Closure may end the original source relation. Its exact ID still belongs
  // to the frozen task identity; a new owner/relation cannot replace it.
  const links = task.issueIdentifier ? await store.runtimeSessionResourceLink.findMany({ where: { runtimeSessionId: primary.id, provider: "linear", connectionId: task.connectionId ?? undefined,
    resourceType: "issue-identifier", externalId: task.issueIdentifier, relationship: "handles" }, take: 101, orderBy: { id: "asc" } }) : [];
  if (links.length > 100 || task.issueIdentifier && !task.connectionId) throw new Error("Compute reclamation source inventory is unavailable");
  const candidates = task.issueIdentifier ? links.map(link => link.id) : [null];
  if (candidates.filter(id => computeTaskIdentity(task, primary.id, environment.machineId, id) === environment.taskIdentity).length !== 1) throw new Error("Compute reclamation historical ownership changed");
  const resource = await store.remoteTaskResource.findUniqueOrThrow({ where: { id: environment.resourceId } });
  if (resource.taskId !== task.id || resource.key !== environment.key || resource.purpose !== environment.purpose) throw new Error("Compute reclamation original resource changed");
  const offers = await store.computeOffer.findMany({ where: { environmentId: environment.id, state: { in: ["claimed", "running", "unknown"] } }, take: 3 });
  const slots = await store.computeSlot.findMany({ where: { allocationId: { in: offers.map(value => value.id) } }, take: 3 });
  if (offers.length > 1 || offers.some(offer => offer.machineId !== environment.machineId) || slots.length !== offers.length || slots.some(slot => slot.machineId !== environment.machineId)) throw new Error("Compute reclamation allocation is ambiguous");
  const sameDirectory = await store.runtimeSession.findMany({ where: { cwd: task.worktreePath }, take: 2001 });
  const family = await cleanupFamily(store, task, primary.id);
  const sessions = [...new Map([...sameDirectory, ...family].map(value => [value.id, value])).values()].sort((a, b) => a.id.localeCompare(b.id));
  if (sessions.length > 2000 || sessions.some(value => value.repositoryId !== task.repositoryId || value.machineId !== task.machineId)) throw new Error("Compute reclamation session inventory changed");
  const relations = await store.runtimeSessionRelation.findMany({ where: { relationship: "spawned-by", OR: [
    { sourceSessionId: { in: sessions.map(value => value.id) } }, { targetSessionId: { in: sessions.map(value => value.id) } },
  ] }, orderBy: { id: "asc" }, take: 4001 });
  if (relations.length > 4000) throw new Error("Compute reclamation relation inventory exceeds its bound");
  const instructions = await store.runtimeInstruction.findMany({ where: { sessionId: { in: sessions.map(value => value.id) }, state: { in: ["queued", "preparing", "dispatching", "unknown"] } }, take: 1001, orderBy: { id: "asc" } });
  const lifecycle = (await Promise.all(sessions.map(value => store.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: value.id }, orderBy: { sequence: "desc" } })))).filter(value => value !== null);
  const ordinarilySettled = computeFamilySettled(task, sessions, instructions, lifecycle, input.runtime);
  const cleanupFence = ordinarilySettled ? null : await releasedComputeCleanupFence({ prisma: store, config: input.config, task, primary, resource,
    sessions, instructions, lifecycle, runtime: input.runtime });
  const settled = ordinarilySettled || Boolean(cleanupFence);
  const identity = finalizationResourceIdentity(resource);
  let configurationDigest: string;
  let originalConfiguration: { configurationFile: string; configurationSha256: string } | null = null;
  let retainedConfiguration: Awaited<ReturnType<typeof retainedComputeConfiguration>> = null;
  if (isSavedComputeEnvironment(environment)) {
    if (identity.identityDigest !== environment.resourceIdentity) throw new Error("Saved reclamation original recipe changed");
    configurationDigest = environment.recipeDigest;
  } else {
    const configuration = z.object({ configurationFile: z.string(), configurationSha256: Sha }).strict().parse(environment.configuration
      ?? z.object({ compute: z.unknown() }).parse(resource.metadata).compute);
    const previous = ComputeObservation.safeParse(environment.observation), reclaimed = ComputeReclamation.safeParse(environment.observation);
    const pinned = environment.configuration || identity.identityDigest === environment.resourceIdentity ? configuration.configurationSha256
      : previous.success ? previous.data.configurationDigest : reclaimed.success ? reclaimed.data.configurationDigest : null;
    if (configuration.configurationSha256 !== pinned) throw new Error("Reclamation has no original physical configuration binding");
    configurationDigest = configuration.configurationSha256;
    originalConfiguration = configuration;
    retainedConfiguration = await retainedComputeConfiguration(store, task, environment, resource, configuration);
  }
  const tuple = { environment, task, primary, links, resource, offers, slots, sessions, relations, instructions, lifecycle, originalConfiguration, retainedConfiguration, cleanupFence,
    environmentGeneration: environment.updatedAt.toISOString(), familyGeneration: computeFamilyGeneration(task, sessions, instructions) };
  return { ...tuple, settled, identity, configurationDigest, digest: finalizationDigest(tuple) };
}

/** Collector-only reconciliation. It cannot resume, classify, install tooling,
 * recreate source, or mutate provider resources. Active authority is unchanged. */
const refreshes = new WeakMap<PrismaClient, Map<string, { machineId: string; work: Promise<{ released: boolean }> }>>();
/** Claim validation may join collectors already checking this host, outside
 * SQL. A failed read still revokes credit; a hung read never holds validation
 * indefinitely. This does not start an observer or grant capacity itself. */
export async function waitForComputeReclamation(prisma: PrismaClient, machineId: string, timeoutMs = 10_000) {
  const pending = [...(refreshes.get(prisma)?.values() ?? [])].filter(value => value.machineId === machineId).map(value => value.work);
  if (!pending.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.allSettled(pending), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Compute reclamation is still collecting; retry the same reservation")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
export async function reclaimStoppedCompute(input: Context, read = readInstalledComputeReclamation) {
  let pending = refreshes.get(input.prisma);
  if (!pending) { pending = new Map(); refreshes.set(input.prisma, pending); }
  const key = JSON.stringify([input.config.machine, input.environmentId]), active = pending.get(key);
  if (active) return active.work;
  const work = (async () => {
    const result = await reclaimStoppedComputeOnce(input, read);
    // Physical stopped/absent proof ends the environment's retained readers.
    if (result.released) await (await import("./tooling-operations.ts")).resolveEnvironmentConsumers(input.prisma, input.environmentId, { kind: "stopped", reference: input.environmentId })
      .catch(error => console.warn(`Retained readers of ${input.environmentId} remain until reconciled: ${error instanceof Error ? error.message : String(error)}`));
    return result;
  })();
  pending.set(key, { machineId: input.config.machine, work });
  try { return await work; } finally { if (pending.get(key)?.work === work) pending.delete(key); }
}
async function reclaimStoppedComputeOnce(input: Context, read = readInstalledComputeReclamation) {
  if (!input.config.compute?.enabled) throw new Error("Compute admission is disabled");
  // Keep the completed observation visible while its replacement is being
  // collected. Admission still enforces its original freshness and identity.
  // Only a completed refusal invalidates that generation; a stale read cannot
  // overwrite an environment which was rebound or observed in the meantime.
  const recorded = await input.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: input.environmentId } });
  if (recorded.machineId !== input.config.machine) throw new Error("Compute reclamation belongs to another host");
  const invalidate = () => input.prisma.$transaction(async tx => {
    const current = await tx.computeEnvironment.findUniqueOrThrow({ where: { id: recorded.id } });
    if (current.updatedAt.getTime() !== recorded.updatedAt.getTime() || finalizationDigest(current) !== finalizationDigest(recorded)) return;
    await tx.computeEnvironment.update({ where: { id: current.id }, data: { state: "unknown" } });
  });
  try {
    const before = await readComputeReclamationSnapshot(input.prisma, input);
    if (!before.task.ownerPaused && before.task.phase !== "closed" && before.resource.state !== "released" || !before.settled) { await invalidate(); return { released: false }; }
    const { environment, task, resource, identity } = before;
    const request = { version: 1, task: { id: task.id, primarySessionId: environment.primarySessionId, toolingRevision: task.toolingRevision, worktreePath: task.worktreePath },
      environment: { id: environment.id, key: environment.key, purpose: environment.purpose, revision: environment.revision, recipeDigest: environment.recipeDigest },
      resource: { ...identity, metadata: before.retainedConfiguration ? { ...z.record(z.string(), z.unknown()).parse(resource.metadata),
        compute: { configurationFile: before.retainedConfiguration.retainedConfigurationFile, configurationSha256: before.configurationDigest } }
        : environment.configuration ? { ...z.record(z.string(), z.unknown()).parse(resource.metadata), compute: environment.configuration } : resource.metadata },
      allocationResourceIdentity: environment.resourceIdentity, configurationDigest: before.configurationDigest };
    const observation = ComputeReclamation.parse(await read(input, task, request));
    if (!["stopped", "absent"].includes(observation.state)) { await invalidate(); return { released: false }; }
    return await input.prisma.$transaction(async tx => {
      const current = await readComputeReclamationSnapshot(tx, input), now = input.now ?? new Date();
      if (!current.settled || current.digest !== before.digest) throw new Error("Compute reclamation changed during observation");
      if (observation.environmentId !== environment.id || observation.taskId !== task.id || observation.primarySessionId !== environment.primarySessionId
        || observation.resourceId !== resource.id || observation.resourceIdentity !== identity.identityDigest || observation.allocationResourceIdentity !== environment.resourceIdentity
        || observation.configurationDigest !== before.configurationDigest || observation.observedAt > now.getTime()
        || now.getTime() - observation.observedAt > input.config.compute!.collectorFreshnessSeconds * 1000) throw new Error("Compute reclamation physical proof changed");
      for (const offer of current.offers) {
        // A still-starting command may be between its last renewal and exec.
        // Only timeout's existing unknown state or a running allocation settles.
        if (offer.state === "claimed") return { released: false };
        await tx.computeOffer.update({ where: { id: offer.id }, data: { state: "stopped", completedAt: now } });
        await tx.computeSlot.update({ where: { id: current.slots[0]!.id }, data: { allocationId: null } });
        await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: environment.primarySessionId, source: `compute:${task.id}`, action: "compute-capacity-reclaimed", key: offer.id,
          value: JSON.stringify({ version: 1, taskIdentity: environment.taskIdentity, offerId: offer.id, previousState: offer.state, observation }) } });
      }
      // Distinct schema prevents this read-only observation becoming a start
      // claim or a Decisions result. Accounting alone can use its fresh absence.
      await tx.computeEnvironment.update({ where: { id: environment.id }, data: { state: "suspended", observation } });
      return { released: true };
    });
  } catch (error) { await invalidate(); throw error; }
}
