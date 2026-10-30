import { z } from "zod";
import { CleanupAdapter, CleanupObserverBatchInput, CleanupObserverBatchResult, CleanupObserverInput, CleanupObserverResource, CleanupTarget } from "./cleanup-observer-schema.ts";
import { CleanupObserverCapability, runCleanupResourceObserver } from "./cleanup-resource-observer.ts";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Identity = { id: z.string().min(1), key: z.string().min(1), kind: z.string().min(1), purpose: z.enum(["development", "browser", "review"]), externalId: z.string().min(1), expiresAt: z.string().nullable(), identityDigest: Hash };
export const CleanupAdapterPlan = z.strictObject({ ...Identity, disposition: z.literal("retire-adapter"), dependencies: z.array(z.string().min(1)).max(1000), stoppedConsumers: z.array(z.string().min(1)).max(1000), adapter: CleanupAdapter,
  targets: z.array(CleanupTarget).min(1).max(1000), observer: z.strictObject({ capability: CleanupObserverCapability, task: CleanupObserverInput.shape.task }) });
export type CleanupAdapterPlan = z.infer<typeof CleanupAdapterPlan>;
export type CleanupAdapterContext = z.infer<typeof CleanupAdapterPlan>["observer"];
type Resource = z.infer<typeof CleanupObserverResource>;
type Identity = z.infer<z.ZodObject<typeof Identity>>;
type Observe = typeof runCleanupResourceObserver;
const adapters: Record<string, z.infer<typeof CleanupAdapter>> = {
  "docker-container": "docker", "docker-network": "docker", "docker-volume": "docker", "docker-compose": "compose", "docker-compose-project": "compose",
  "task-runtime": "runtime", "native-app": "native", "local-process": "native", "local-http": "endpoint", "public-preview": "preview", "cloudflare-dns-record": "preview", "cloudflare-dns-route": "preview", "cloudflare-tunnel": "preview",
};
export const hasCleanupAdapter = (kind: string) => Object.hasOwn(adapters, kind);
/** Old endpoint receipts may describe a superseded process using a port now
 * owned by another receipt. Only independently addressable historical Docker
 * identities enter the absence observer; history alone grants no effect. */
export function hasHistoricalCleanupAdapter(resource: { kind: string; metadata?: unknown }) {
  if (["docker-container", "docker-network", "docker-volume"].includes(resource.kind)) return true;
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
export async function assertCleanupAdapterResources(input: { taskId: string; resources: Resource[]; plan: CleanupAdapterPlan[]; removed: boolean }, observe: Observe = runCleanupResourceObserver) {
  if (!input.plan.length) return;
  const plans = input.plan.map(plan => CleanupAdapterPlan.parse(plan)), context = plans[0]!.observer;
  if (context.task.id !== input.taskId || plans.some(plan => !same(plan.observer, context))) throw new Error("Cleanup observer task or committed capability changed");
  const request = CleanupObserverBatchInput.parse({ version: 1, task: context.task, resources: input.resources, stage: "confirm", observations: plans.map(plan => ({ resourceId: plan.id, expectedTargets: plan.targets })) });
  const result = resultScope(request, await observe({ capability: context.capability, request }), new Map(plans.map(plan => [plan.id, plan.identityDigest])));
  for (const plan of plans) {
    const current = result.observations.find(item => item.resourceId === plan.id)!;
    const record = input.resources.find(record => record.id === plan.id)!;
    if (current.adapter !== plan.adapter || !same([...current.dependencies].sort(), [...plan.dependencies].sort()) || !same([...current.stoppedConsumers].sort(), [...plan.stoppedConsumers].sort())) throw new Error("Cleanup observer adapter or dependency plan changed");
    if (input.removed && record.state !== "released" || (input.removed || record.state === "released") && !current.absent) throw new Error("Prepared physical resource has no independently verified retirement");
    if (record.state === "released") for (const id of plan.stoppedConsumers) {
      const consumer = result.observations.find(item => item.resourceId === id);
      const families = consumer?.targets.filter(target => target.kind === "native-family") ?? [];
      if (!consumer || !families.length || families.some(target => consumer.presentTargetDigests.includes(target.identityDigest))) throw new Error("Prepared store retirement still has an active or unverified native consumer");
    }
  }
  return result;
}
