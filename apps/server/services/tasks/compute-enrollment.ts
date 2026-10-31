import path from "node:path";
import { z } from "zod";
import type { PrismaClient, ComputeEnvironment } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { computeTaskOwner, ComputeRequest } from "./compute-admission.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";
import { readConfiguredComputeObservation } from "./compute-observer.ts";
import { recordComputeObservation } from "./compute-observation.ts";

export const ComputeEnrollment = ComputeRequest.omit({ saved: true }).extend({ environmentId: z.string().uuid(), resourceIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  configuration: z.object({ configurationFile: z.string().min(1).max(4096).refine(value => path.isAbsolute(value) && path.normalize(value) === value), configurationSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
}).strict();
/** Existing owner-only configuration coordination. This records independent
 * coverage of an exact existing resource; it grants no start or stop authority,
 * rewrites no resource metadata, and creates no offer or allocation. */
export async function enrollCompute(input: { prisma: PrismaClient; config: ServerConfig; taskId: string; request: z.infer<typeof ComputeEnrollment> }, read = readConfiguredComputeObservation) {
  if (!input.config.compute?.enabled) throw new Error("Compute admission is disabled");
  const request = ComputeEnrollment.parse(input.request);
  const before = await computeTaskOwner(input.prisma, input.taskId, input.config.machine);
  const resource = await input.prisma.remoteTaskResource.findUniqueOrThrow({ where: { taskId_key: { taskId: input.taskId, key: request.key } } });
  if (resource.state === "released" || resource.purpose !== request.purpose || !["task-runtime", "docker-compose-project"].includes(resource.kind)
    || finalizationResourceIdentity(resource).identityDigest !== request.resourceIdentity) throw new Error("Compute enrollment resource changed");
  const { environmentId, resourceIdentity, configuration, ...recipe } = request;
  const environment: ComputeEnvironment = { id: environmentId, taskId: input.taskId, primarySessionId: before.session.id, machineId: input.config.machine,
    taskIdentity: before.identity, ...recipe, resourceId: resource.id, resourceIdentity, configuration, observation: null, state: "unknown", createdAt: new Date(), updatedAt: new Date() };
  const original = await input.prisma.computeEnvironment.findUnique({ where: { taskId_key: { taskId: input.taskId, key: request.key } } });
  const matches = (prior: ComputeEnvironment) => prior.id === environmentId && prior.taskIdentity === before.identity && prior.resourceId === resource.id && prior.resourceIdentity === resourceIdentity
    && prior.revision === recipe.revision && prior.recipeDigest === recipe.recipeDigest && finalizationDigest(prior.configuration) === finalizationDigest(configuration);
  if (original && !matches(original)) throw new Error("An existing compute enrollment must retain its exact identity");
  const traffic = await input.prisma.computeTraffic.findMany({ where: { environmentId }, orderBy: { routeId: "asc" }, take: 33 });
  if (traffic.length > 32) throw new Error("Compute enrollment route inventory exceeds its bound");
  const observed = await read(input, before.task, original ?? environment, resource, traffic);
  return input.prisma.$transaction(async tx => {
    const after = await computeTaskOwner(tx, input.taskId, input.config.machine);
    const current = await tx.remoteTaskResource.findUniqueOrThrow({ where: { id: resource.id } });
    if (after.identity !== before.identity || current.state !== resource.state || finalizationResourceIdentity(current).identityDigest !== resourceIdentity) throw new Error("Compute enrollment changed during observation");
    const prior = await tx.computeEnvironment.findUnique({ where: { taskId_key: { taskId: input.taskId, key: request.key } } });
    const currentTraffic = await tx.computeTraffic.findMany({ where: { environmentId }, orderBy: { routeId: "asc" }, take: 33 });
    if (finalizationDigest(prior) !== finalizationDigest(original) || finalizationDigest(currentTraffic) !== finalizationDigest(traffic)) throw new Error("Compute enrollment changed during observation");
    if (!prior) await tx.computeEnvironment.create({ data: { ...environment, configuration, observation: undefined } });
    const observation = await recordComputeObservation({ ...input, prisma: tx, environmentId, observation: observed.observation });
    if (observed.traffic.length !== observation.routes.length || observed.traffic.some(state => !observation.routes.some(route => finalizationDigest(route) === finalizationDigest(state.route)))) throw new Error("Compute enrollment route proof changed");
    for (const state of observed.traffic) {
      const previous = await tx.computeTraffic.findUnique({ where: { routeId: state.route.id } });
      if (previous && (previous.environmentId !== environmentId || previous.taskId !== input.taskId || previous.epoch !== state.epoch || previous.sequence > state.sequence)) throw new Error("Compute enrollment route is already owned or changed");
      await tx.computeTraffic.upsert({ where: { routeId: state.route.id }, create: { routeId: state.route.id, taskId: input.taskId, environmentId, epoch: state.epoch, sequence: state.sequence, state }, update: { sequence: state.sequence, state } });
    }
    return { environmentId, taskId: input.taskId, resourceId: resource.id, resourceIdentity, coverage: observation.coverage, state: observation.state };
  });
}
