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

type Store = Prisma.TransactionClient;
type Context = { prisma: PrismaClient; config: ServerConfig; environmentId: string; runtime: Pick<AgentSessionRuntime, "observeSessionActivity">; now?: Date };
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
async function snapshot(store: Store, input: Context) {
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
  const settled = instructions.length === 0 && sessions.every(value => (["idle", "closed"].includes(value.status))
    && !["executing", "queued"].includes(input.runtime.observeSessionActivity?.(value.id)?.state ?? "")
    && (value.closedAt || lifecycle.find(event => event.runtimeSessionId === value.id)?.phase !== "started"));
  const identity = finalizationResourceIdentity(resource);
  let configurationDigest: string;
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
  }
  const tuple = { environment, task, primary, links, resource, offers, slots, sessions, relations, instructions, lifecycle };
  return { ...tuple, settled, identity, configurationDigest, digest: finalizationDigest(tuple) };
}

/** Collector-only reconciliation. It cannot resume, classify, install tooling,
 * recreate source, or mutate provider resources. Active authority is unchanged. */
export async function reclaimStoppedCompute(input: Context, read = readInstalledComputeReclamation) {
  if (!input.config.compute?.enabled) throw new Error("Compute admission is disabled");
  // Retire any earlier zero-capacity observation before a fallible physical
  // read. Failed/unknown/restarted compute must not reuse a fresh stopped cache.
  // This is conservative accounting only; no resource or owner fact changes.
  const recorded = await input.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: input.environmentId } });
  if (recorded.machineId !== input.config.machine) throw new Error("Compute reclamation belongs to another host");
  const invalidated = await input.prisma.computeEnvironment.updateMany({ where: { id: recorded.id, machineId: input.config.machine, updatedAt: recorded.updatedAt }, data: { state: "unknown" } });
  if (invalidated.count !== 1) throw new Error("Compute reclamation allocation changed before observation");
  const before = await snapshot(input.prisma, input);
  if (!before.task.ownerPaused && before.task.phase !== "closed" && before.resource.state !== "released" || !before.settled) return { released: false };
  const { environment, task, resource, identity } = before;
  const request = { version: 1, task: { id: task.id, primarySessionId: environment.primarySessionId, toolingRevision: task.toolingRevision, worktreePath: task.worktreePath },
    environment: { id: environment.id, key: environment.key, purpose: environment.purpose, revision: environment.revision, recipeDigest: environment.recipeDigest },
    resource: { ...identity, metadata: environment.configuration ? { ...z.record(z.string(), z.unknown()).parse(resource.metadata), compute: environment.configuration } : resource.metadata },
    allocationResourceIdentity: environment.resourceIdentity, configurationDigest: before.configurationDigest };
  const observation = ComputeReclamation.parse(await read(input, task, request));
  if (!["stopped", "absent"].includes(observation.state)) return { released: false };
  return input.prisma.$transaction(async tx => {
    const current = await snapshot(tx, input), now = input.now ?? new Date();
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
}
