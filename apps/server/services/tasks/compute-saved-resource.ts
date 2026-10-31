import { z } from "zod";
import type { Prisma, ComputeEnvironment } from "../../../../generated/prisma/client.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";
import type { ComputeObservation } from "./compute-observation.ts";

export const SavedComputeBinding = z.object({ resourceId: z.string().min(1).max(256), resourceIdentity: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type Binding = z.infer<typeof SavedComputeBinding>;
const kinds = new Set(["native-app", "docker-container", "docker-compose-project", "launch-agent"]);
export class SavedComputeIdentityChanged extends Error {}
export function savedComputeDigest(binding: Binding) {
  return finalizationDigest({ version: 1, adapter: "saved-compute", ...SavedComputeBinding.parse(binding) });
}
export function isSavedComputeEnvironment(environment: ComputeEnvironment) {
  return environment.configuration === null && environment.resourceId !== null && environment.resourceIdentity !== null
    && environment.recipeDigest === savedComputeDigest({ resourceId: environment.resourceId, resourceIdentity: environment.resourceIdentity });
}
/** Bind an existing resource; this grants neither coverage nor a start effect. */
export async function assertSavedComputeResource(store: Pick<Prisma.TransactionClient, "remoteTaskResource">,
  input: { taskId: string; key: string; purpose: string; recipeDigest: string; saved: Binding }) {
  const resource = await store.remoteTaskResource.findUnique({ where: { id: input.saved.resourceId } });
  if (input.purpose !== "development" || !resource || resource.taskId !== input.taskId || resource.key !== input.key || resource.purpose !== input.purpose || resource.state === "released"
    || !kinds.has(resource.kind) || finalizationResourceIdentity(resource).identityDigest !== input.saved.resourceIdentity
    || savedComputeDigest(input.saved) !== input.recipeDigest) throw new SavedComputeIdentityChanged("Saved compute resource identity changed");
  return resource;
}
export function assertSavedComputeRequest(environment: ComputeEnvironment, saved?: Binding) {
  const bound = isSavedComputeEnvironment(environment);
  if (Boolean(saved) !== bound || saved && (environment.resourceId !== saved.resourceId || environment.resourceIdentity !== saved.resourceIdentity)) {
    throw new Error("Compute request does not match its saved resource binding");
  }
}
/** Physical-only enrollment cannot claim complete traffic or job coverage. */
export function assertSavedComputeObservation(environment: ComputeEnvironment, observation: ComputeObservation, allowActualRevision = false) {
  if (observation.resourceId !== environment.resourceId || observation.resourceIdentity !== environment.resourceIdentity
    || observation.environmentId !== environment.id || observation.taskId !== environment.taskId || observation.primarySessionId !== environment.primarySessionId
    || observation.recipeDigest !== environment.recipeDigest || !allowActualRevision && observation.revision !== environment.revision || observation.purpose !== environment.purpose
    || observation.configurationDigest !== environment.recipeDigest || observation.routes.length || observation.coverage !== "incomplete"
    || observation.operations.coverage !== "incomplete") throw new Error("Saved compute requires its exact physical-only observation");
}
export function assertSavedComputeStopped(environment: ComputeEnvironment, observed: ComputeObservation, now: Date, freshnessSeconds: number) {
  // A physical read can reconcile an older allocation after a product commit,
  // but starting always claims exactly the environment's current generation.
  assertSavedComputeObservation(environment, observed);
  const age = now.getTime() - observed.observedAt;
  if (observed.state !== "stopped" || age < 0 || age > freshnessSeconds * 1000) throw new Error("Saved compute requires a fresh stopped observation before claiming");
}
