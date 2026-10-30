import { z } from "zod";
import type { RetainedPreviewInput } from "./cleanup-preview-retained-schema.ts";
import { CleanupAdapter, CleanupObserverBatchInput, CleanupObserverBatchResult, CleanupObserverInput, CleanupObserverResource, CleanupTarget } from "./cleanup-observer-schema.ts";
import { CleanupObserverCapability, runCleanupResourceObserver } from "./cleanup-resource-observer.ts";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Identity = { id: z.string().min(1), key: z.string().min(1), kind: z.string().min(1), purpose: z.enum(["development", "browser", "review", "tooling"]), savedDataResourceId: z.string().min(1).optional(), externalId: z.string().min(1), expiresAt: z.string().nullable(), identityDigest: Hash };
export const CleanupAdapterPlan = z.strictObject({ ...Identity, disposition: z.literal("retire-adapter"), dependencies: z.array(z.string().min(1)).max(1000), stoppedConsumers: z.array(z.string().min(1)).max(1000), adapter: CleanupAdapter,
  targets: z.array(CleanupTarget).min(1).max(1000), observer: z.strictObject({ capability: CleanupObserverCapability, task: CleanupObserverInput.shape.task }) });
export type CleanupAdapterPlan = z.infer<typeof CleanupAdapterPlan>;
export type CleanupAdapterContext = z.infer<typeof CleanupAdapterPlan>["observer"];
type Resource = z.infer<typeof CleanupObserverResource>;
type Identity = z.infer<z.ZodObject<typeof Identity>>;
type Observe = typeof runCleanupResourceObserver;
const adapters: Record<string, z.infer<typeof CleanupAdapter>> = {
  "docker-container": "docker", "docker-network": "docker", "docker-volume": "docker", "docker-compose": "compose", "docker-compose-project": "compose",
  "task-runtime": "runtime", "planetscale-branch": "runtime", "native-app": "native", "local-process": "native", "local-http": "endpoint", "public-preview": "preview", "cloudflare-dns-record": "preview", "cloudflare-dns-route": "preview", "cloudflare-tunnel": "preview",
  "browser-profile": "browser",
  "clerk-test-user": "clerk", "clerk-test-session": "clerk",
  "browser-auth": "vault",
};
export const hasCleanupAdapter = (kind: string) => Object.hasOwn(adapters, kind);
/** Old endpoint receipts may describe a superseded process using a port now
 * owned by another receipt. Only independently addressable historical Docker or standalone provider
 * identities enter the absence observer; history alone grants no effect. */
export function hasHistoricalCleanupAdapter(resource: { kind: string; purpose?: string; metadata?: unknown }, resources: Array<{ kind: string; purpose?: string; state?: string; metadata?: unknown }> = []) {
  if (["docker-container", "docker-network", "docker-volume", "planetscale-branch"].includes(resource.kind)) return true;
  if (resource.kind === "task-runtime") {
    const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const metadata = object(resource.metadata);
    if (typeof metadata.recipeHash !== "string" || !/^[a-f0-9]{64}$/.test(metadata.recipeHash) || !Array.isArray(metadata.providers)) return false;
    // Observe a released runtime only when an unresolved logical object record
    // still needs its exact bucket. Other historical runtimes stay historical.
    // The actual runtime file and every provider target must independently
    // prove absence before this can enter a plan; Released is not that proof.
    const providers = metadata.providers.map(object);
    return resources.some(candidate => {
      if (candidate.kind !== "s3-object" || candidate.state === "released" || candidate.purpose !== resource.purpose) return false;
      const stored = object(candidate.metadata), bucket = typeof stored.bucket === "string" ? /^(drafted-[a-z0-9-]+) \(task R2\)$/.exec(stored.bucket)?.[1] : undefined;
      return Boolean(bucket && Array.isArray(stored.objects) && providers.filter(provider => provider.provider === "storage" && provider.id === bucket && provider.name === bucket).length === 1);
    });
  }
  if (!["docker-compose", "docker-compose-project"].includes(resource.kind)) return false;
  const metadata = resource.metadata;
  return Boolean(metadata && typeof metadata === "object" && !Array.isArray(metadata) && "containers" in metadata && "configPath" in metadata);
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function resultScope(input: z.infer<typeof CleanupObserverBatchInput>, value: unknown, identities: Map<string, string>) {
  let result: z.infer<typeof CleanupObserverBatchResult>;
  try { result = CleanupObserverBatchResult.parse(value); }
  catch { throw new Error("Cleanup observer returned an invalid resource proof; absence is unverified"); }
  if (result.taskId !== input.task.id || result.observations.length !== input.observations.length) throw new Error("Cleanup observer returned a different resource set");
  for (const item of result.observations) {
    const selected = input.observations.find(selected => selected.resourceId === item.resourceId);
    const record = input.resources.find(record => record.id === item.resourceId);
    if (!selected || !record || !hasCleanupAdapter(record.kind) || item.adapter !== adapters[record.kind] || item.resourceIdentityDigest !== identities.get(item.resourceId)
      || item.targets.some(target => target.scope.taskId !== input.task.id || target.scope.purpose !== record.purpose)
      || [...item.dependencies, ...item.stoppedConsumers].some(id => !input.resources.some(record => record.id === id))) throw new Error("Cleanup observer resource ownership or dependencies changed");
    if (input.stage === "confirm" && !same(item.targets, selected.expectedTargets)) throw new Error("Cleanup observer target identity changed since preparation");
  }
  return result;
}

/** One immutable-code check and one bounded subprocess cover all physical
 * adapters at a plan boundary. Evidence files are not sent as separate runs. */
export async function prepareCleanupAdapterResources(input: { context: CleanupAdapterContext; resources: Resource[]; identities: Identity[] }, observe: Observe = runCleanupResourceObserver) {
  const request = CleanupObserverBatchInput.parse({ version: 1, task: input.context.task, resources: input.resources, stage: "prepare", observations: input.identities.map(identity => ({ resourceId: identity.id })) });
  const result = resultScope(request, await observe({ capability: input.context.capability, request }), new Map(input.identities.map(identity => [identity.id, identity.identityDigest])));
  return input.identities.map(identity => {
    const observed = result.observations.find(item => item.resourceId === identity.id)!;
    if (input.resources.find(resource => resource.id === identity.id)!.state === "released"
      && (!observed.absent || observed.targets.some(target => target.presentAtPrepare))) throw new Error("Historical released adapter is still present or has no initial absence proof");
    return CleanupAdapterPlan.parse({ ...identity, disposition: "retire-adapter", dependencies: observed.dependencies, stoppedConsumers: observed.stoppedConsumers, adapter: observed.adapter, targets: observed.targets, observer: input.context });
  });
}

/** Released is only a receipt state. A full confirm still independently proves
 * every prepared target absent, and a replay cannot absorb recreated targets. */
export async function assertCleanupAdapterResources(input: { taskId: string; resources: Resource[]; plan: CleanupAdapterPlan[]; removed: boolean; retainedTargets?: Map<string, string[]>; retainedPreviewInputs?: RetainedPreviewInput[]; previewObserver?: () => Promise<CleanupObserverCapability> }, observe: Observe = runCleanupResourceObserver) {
  if (!input.plan.length) return;
  const plans = input.plan.map(plan => CleanupAdapterPlan.parse(plan)), context = plans[0]!.observer;
  if (context.task.id !== input.taskId || plans.some(plan => !same(plan.observer, context))) throw new Error("Cleanup observer task or committed capability changed");
  const request = CleanupObserverBatchInput.parse({ version: 1, task: context.task, resources: input.resources, stage: "confirm", observations: plans.map(plan => ({ resourceId: plan.id, expectedTargets: plan.targets })) });
  const retained = input.retainedPreviewInputs ?? [];
  const recovered = plans.filter(plan => plan.adapter === "preview" && retained.some(value => input.resources.find(resource => resource.id === value.resourceId)?.purpose === plan.purpose));
  let value: unknown;
  if (recovered.length) {
    if (!input.previewObserver) throw new Error("Captured preview confirmation requires a compatible configured observer");
    const current = await input.previewObserver();
    const ordinary = request.observations.filter(item => !recovered.some(plan => plan.id === item.resourceId));
    const observations = [];
    if (ordinary.length) observations.push(...resultScope({ ...request, observations: ordinary }, await observe({ capability: context.capability, request: { ...request, observations: ordinary } }), new Map(plans.map(plan => [plan.id, plan.identityDigest]))).observations);
    const recoveredRequest = CleanupObserverBatchInput.parse({ ...request, observations: request.observations.filter(item => recovered.some(plan => plan.id === item.resourceId)), retainedPreviewInputs: retained });
    observations.push(...resultScope(recoveredRequest, await observe({ capability: context.capability, compatibleCapability: current, request: recoveredRequest }), new Map(plans.map(plan => [plan.id, plan.identityDigest]))).observations);
    value = { version: 1, taskId: input.taskId, observations };
  } else value = await observe({ capability: context.capability, request });
  const result = resultScope(request, value, new Map(plans.map(plan => [plan.id, plan.identityDigest])));
  for (const plan of plans) {
    const current = result.observations.find(item => item.resourceId === plan.id)!;
    const record = input.resources.find(record => record.id === plan.id)!;
    if (current.adapter !== plan.adapter || !same([...current.dependencies].sort(), [...plan.dependencies].sort()) || !same([...current.stoppedConsumers].sort(), [...plan.stoppedConsumers].sort())) throw new Error("Cleanup observer adapter or dependency plan changed");
    const retained = input.retainedTargets?.get(plan.id);
    if (retained) {
      if (!retained.length || new Set(retained).size !== retained.length || record.state !== "ready" || retained.some(digest => !plan.targets.some(target => target.identityDigest === digest && target.presentAtPrepare) || !current.presentTargetDigests.includes(digest))
        || input.removed && current.presentTargetDigests.some(digest => !retained.includes(digest))) throw new Error("Preserved adapter has a changed retained target or unfinished retired partition");
    } else if (input.removed && record.state !== "released" || (input.removed || record.state === "released") && !current.absent) throw new Error("Prepared physical resource has no independently verified retirement");
    if (record.state === "released" || retained && input.removed) for (const id of plan.stoppedConsumers) {
      const consumer = result.observations.find(item => item.resourceId === id);
      const families = consumer?.targets.filter(target => target.kind === "native-family") ?? [];
      if (!consumer || !families.length || families.some(target => consumer.presentTargetDigests.includes(target.identityDigest))) throw new Error("Prepared store retirement still has an active or unverified native consumer");
    }
  }
  return result;
}
