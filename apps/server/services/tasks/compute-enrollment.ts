import path from "node:path";
import { z } from "zod";
import type { PrismaClient, ComputeEnvironment } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { computeTaskOwner, ComputeRequest, savedRevisionAllocations, withdrawComputeConfigurationOffers } from "./compute-admission.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";
import { readConfiguredComputeObservation } from "./compute-observer.ts";
import { ComputeObservation, recordComputeObservation } from "./compute-observation.ts";

export const ComputeEnrollment = ComputeRequest.omit({ saved: true }).extend({ environmentId: z.string().uuid(), resourceIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  configuration: z.object({ configurationFile: z.string().min(1).max(4096).refine(value => path.isAbsolute(value) && path.normalize(value) === value), configurationSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
}).strict();
export async function computeEnrollmentStatus(input: { prisma: PrismaClient; config: ServerConfig; taskId: string; key: string }) {
  const owner = await computeTaskOwner(input.prisma, input.taskId, input.config.machine, { allowPaused: true });
  const resource = await input.prisma.remoteTaskResource.findUniqueOrThrow({ where: { taskId_key: { taskId: input.taskId, key: input.key } } });
  if (resource.state === "released" || resource.purpose !== "development" || resource.kind !== "docker-compose-project") throw new Error("Legacy enrollment requires its existing development Compose group");
  const environment = await input.prisma.computeEnvironment.findUnique({ where: { taskId_key: { taskId: input.taskId, key: input.key } } });
  if (environment && (environment.taskIdentity !== owner.identity || environment.resourceId !== resource.id || environment.resourceIdentity !== finalizationResourceIdentity(resource).identityDigest)) throw new Error("Existing compute enrollment ownership changed");
  return { taskId: input.taskId, primarySessionId: owner.session.id, ownerPaused: owner.task.ownerPaused, resourceId: resource.id, resourceIdentity: finalizationResourceIdentity(resource).identityDigest,
    environment: environment ? { id: environment.id, revision: environment.revision, recipeDigest: environment.recipeDigest, configuration: environment.configuration, state: environment.state } : null };
}
/** Existing owner-only configuration coordination. This records independent
 * coverage of an exact existing resource; it grants no start or stop authority,
 * rewrites no resource metadata, and creates no offer or allocation. */
export async function enrollCompute(input: { prisma: PrismaClient; config: ServerConfig; taskId: string; request: z.infer<typeof ComputeEnrollment> }, read = readConfiguredComputeObservation) {
  if (!input.config.compute?.enabled) throw new Error("Compute admission is disabled");
  const request = ComputeEnrollment.parse(input.request);
  const before = await computeTaskOwner(input.prisma, input.taskId, input.config.machine, { allowPaused: true });
  const resource = await input.prisma.remoteTaskResource.findUniqueOrThrow({ where: { taskId_key: { taskId: input.taskId, key: request.key } } });
  if (resource.state === "released" || resource.purpose !== request.purpose || !["task-runtime", "docker-compose-project"].includes(resource.kind)
    || finalizationResourceIdentity(resource).identityDigest !== request.resourceIdentity) throw new Error("Compute enrollment resource changed");
  const { environmentId, resourceIdentity, configuration, ...recipe } = request;
  const environment: ComputeEnvironment = { id: environmentId, taskId: input.taskId, primarySessionId: before.session.id, machineId: input.config.machine,
    taskIdentity: before.identity, ...recipe, resourceId: resource.id, resourceIdentity, configuration, observation: null, state: "unknown", createdAt: new Date(), updatedAt: new Date() };
  const original = await input.prisma.computeEnvironment.findUnique({ where: { taskId_key: { taskId: input.taskId, key: request.key } } });
  const matches = (prior: ComputeEnvironment) => prior.id === environmentId && prior.taskIdentity === before.identity && prior.resourceId === resource.id && prior.resourceIdentity === resourceIdentity
    && prior.revision === recipe.revision && prior.recipeDigest === recipe.recipeDigest && finalizationDigest(prior.configuration) === finalizationDigest(configuration);
  const transition = original && !matches(original);
  if (transition && (original.id !== environmentId || original.taskIdentity !== before.identity || original.resourceId !== resource.id
    || original.resourceIdentity !== resourceIdentity || original.purpose !== recipe.purpose || recipe.purpose !== "development" || resource.kind !== "docker-compose-project")) throw new Error("An existing compute enrollment must retain its exact resource identity");
  const allocations = transition || before.task.ownerPaused ? await savedRevisionAllocations(input.prisma, environmentId) : undefined;
  const traffic = await input.prisma.computeTraffic.findMany({ where: { environmentId }, orderBy: { routeId: "asc" }, take: 33 });
  if (traffic.length > 32) throw new Error("Compute enrollment route inventory exceeds its bound");
  const observed = await read(input, before.task, transition ? environment : original ?? environment, resource, transition ? [] : traffic);
  const assertStopped = () => {
    const value = ComputeObservation.parse(observed.observation), now = Date.now();
    if (value.state !== "stopped" || value.revision !== recipe.revision || value.recipeDigest !== recipe.recipeDigest || value.configurationDigest !== configuration.configurationSha256
      || value.observedAt > now || now - value.observedAt > input.config.compute!.collectorFreshnessSeconds * 1000
      || value.coverage !== "incomplete" || value.operations.coverage !== "incomplete" || value.operations.active !== 0 || value.routes.length || observed.traffic.length) throw new Error("Instrumentation transition requires fresh stopped incomplete observation");
  };
  if (transition || before.task.ownerPaused) assertStopped();
  return input.prisma.$transaction(async tx => {
    const after = await computeTaskOwner(tx, input.taskId, input.config.machine, { allowPaused: true });
    const current = await tx.remoteTaskResource.findUniqueOrThrow({ where: { id: resource.id } });
    if (after.identity !== before.identity || after.task.ownerPaused !== before.task.ownerPaused || current.state !== resource.state || finalizationResourceIdentity(current).identityDigest !== resourceIdentity) throw new Error("Compute enrollment changed during observation");
    const prior = await tx.computeEnvironment.findUnique({ where: { taskId_key: { taskId: input.taskId, key: request.key } } });
    const currentTraffic = await tx.computeTraffic.findMany({ where: { environmentId }, orderBy: { routeId: "asc" }, take: 33 });
    if (finalizationDigest(prior) !== finalizationDigest(original) || finalizationDigest(currentTraffic) !== finalizationDigest(traffic)) throw new Error("Compute enrollment changed during observation");
    if (allocations && finalizationDigest(await savedRevisionAllocations(tx, environmentId)) !== finalizationDigest(allocations)) throw new Error("Compute enrollment allocation changed during observation");
    if (transition && prior) {
      assertStopped();
      await withdrawComputeConfigurationOffers(tx, prior, allocations!, new Date());
      await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: before.session.id, source: `compute:${input.taskId}`, action: "compute-instrumentation-transition",
        key: finalizationDigest({ environmentId, previous: finalizationDigest(original), configuration }), value: JSON.stringify({ version: 1, environmentId, taskIdentity: before.identity,
          resourceId: resource.id, resourceIdentity, previous: original, previousTraffic: traffic.map(value => ({ routeId: value.routeId, digest: finalizationDigest(value) })), observation: observed.observation, configuration,
          offers: allocations!.offers.map(value => ({ id: value.id, state: value.state, instructionId: value.instructionId })) }) } });
      await tx.computeEnvironment.update({ where: { id: environmentId }, data: { revision: recipe.revision, recipeDigest: recipe.recipeDigest, configuration, state: "suspended" } });
      await tx.computeTraffic.deleteMany({ where: { environmentId } });
    }
    if (!prior) await tx.computeEnvironment.create({ data: { ...environment, state: observed.observation.state === "stopped" ? "suspended" : "unknown", configuration, observation: undefined } });
    const observation = await recordComputeObservation({ ...input, prisma: tx, environmentId, observation: observed.observation, ...(before.task.ownerPaused ? { ownerEnrollment: true as const } : {}) });
    if (observed.traffic.length !== observation.routes.length || observed.traffic.some(state => !observation.routes.some(route => finalizationDigest(route) === finalizationDigest(state.route)))) throw new Error("Compute enrollment route proof changed");
    for (const state of observed.traffic) {
      const previous = await tx.computeTraffic.findUnique({ where: { routeId: state.route.id } });
      if (previous && (previous.environmentId !== environmentId || previous.taskId !== input.taskId || previous.epoch !== state.epoch || previous.sequence > state.sequence)) throw new Error("Compute enrollment route is already owned or changed");
      await tx.computeTraffic.upsert({ where: { routeId: state.route.id }, create: { routeId: state.route.id, taskId: input.taskId, environmentId, epoch: state.epoch, sequence: state.sequence, state }, update: { sequence: state.sequence, state } });
    }
    return { environmentId, taskId: input.taskId, resourceId: resource.id, resourceIdentity, coverage: observation.coverage, state: observation.state };
  });
}
