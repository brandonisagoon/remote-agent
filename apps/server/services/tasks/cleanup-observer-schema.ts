import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { RetainedPreviewInput } from "./cleanup-preview-retained-schema.ts";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Nonempty = z.string().min(1);
const Absolute = z.string().max(4096).refine(value => path.isAbsolute(value) && path.normalize(value) === value);
const Purpose = z.enum(["development", "review", "browser"]);
const Scope = { taskId: z.string().min(1), purpose: Purpose };
const Common = { id: z.string().min(1), presentAtPrepare: z.boolean(), identityDigest: Hash };
const DockerScope = z.strictObject({ ...Scope, purpose: z.enum(["development", "review", "browser", "tooling"]), project: Nonempty.optional(), operation: Nonempty.optional(), name: Nonempty.optional(),
  compose: z.strictObject({ file: Absolute, sha256: Hash, dev: z.number().int().nonnegative(), ino: z.number().int().nonnegative(), mode: z.number().int().nonnegative(), member: Nonempty }).optional(),
});
const DockerIdentity = z.strictObject({ createdAt: z.string().min(1), labelsDigest: Hash });
const ProviderScope = { ...Scope, runtimeFile: Absolute, credentialsFile: Absolute, recipeHash: Hash };
const ClerkCredentials = z.strictObject({ backupFile: Absolute, backupSha256: Hash, keyFile: Absolute, keyId: Hash });
const ClerkScope = z.strictObject({ ...Scope, instanceId: z.string().regex(/^ins_[A-Za-z0-9]+$/), credentials: ClerkCredentials });

/** Only known provider/host identity fields cross the observer boundary.
 * Credentials, environment values, scripts and arbitrary commands do not. */
export const CleanupTarget = z.discriminatedUnion("kind", [
  z.strictObject({ ...Common, kind: z.literal("docker-container"), id: Nonempty, scope: DockerScope,
    identity: DockerIdentity.extend({ name: Nonempty.optional(), image: z.string().min(1), networks: z.array(z.string()), volumes: z.array(z.string()) }).strict().nullable() }),
  z.strictObject({ ...Common, kind: z.literal("docker-network"), id: Nonempty, scope: DockerScope,
    identity: DockerIdentity.extend({ name: z.string().min(1) }).strict().nullable() }),
  z.strictObject({ ...Common, kind: z.literal("docker-volume"), scope: DockerScope, identity: DockerIdentity.nullable() }),
  z.strictObject({ ...Common, kind: z.literal("planetscale-branch"), scope: z.strictObject({ ...ProviderScope, organization: Nonempty, database: Nonempty, baseBranch: Nonempty, baseBranchId: Nonempty }), name: Nonempty }),
  z.strictObject({ ...Common, kind: z.literal("neon-branch"), scope: z.strictObject({ ...ProviderScope, projectId: Nonempty, baselineBranchId: Nonempty }), name: Nonempty }),
  z.strictObject({ ...Common, kind: z.literal("upstash-database"), scope: z.strictObject(ProviderScope), name: z.string().min(1), createdAt: z.string().min(1) }),
  z.strictObject({ ...Common, kind: z.literal("r2-bucket"), scope: z.strictObject({ ...ProviderScope, accountId: z.string().regex(/^[a-f0-9]{32}$/) }), name: z.string().min(1), createdAt: z.string().min(1) }),
  z.strictObject({ ...Common, kind: z.literal("cloudflare-dns-record"), scope: z.strictObject({ ...Scope, zoneId: z.string().regex(/^[a-f0-9]{32}$/) }), name: z.string().min(1), type: z.string().min(1), contentDigest: Hash }),
  z.strictObject({ ...Common, kind: z.literal("cloudflare-tunnel"), scope: z.strictObject({ ...Scope, accountId: z.string().regex(/^[a-f0-9]{32}$/) }), name: z.string().min(1) }),
  z.strictObject({ ...Common, kind: z.literal("cloudflare-ingress-route"), scope: z.strictObject({ ...Scope, accountId: z.string().regex(/^[a-f0-9]{32}$/), tunnelId: z.string().min(1) }), hostname: z.string().min(1), routeDigest: Hash }),
  z.strictObject({ ...Common, kind: z.literal("local-ingress-route"), scope: z.strictObject({ ...Scope, configFile: Absolute, tunnelId: Nonempty }), hostname: Nonempty, sourceDigest: Hash, routeDigest: Hash }),
  z.strictObject({ ...Common, kind: z.literal("native-family"), scope: z.strictObject({ ...Scope, anchorKey: z.string().min(1) }), proof: z.strictObject({ file: Absolute, sha256: Hash }), planDigest: Hash }),
  z.strictObject({ ...Common, kind: z.literal("local-endpoint"), scope: z.strictObject({ ...Scope, anchorKey: z.string().min(1) }), url: z.url(), nativeProofDigest: Hash }),
  z.strictObject({ ...Common, kind: z.literal("browser-session"), scope: z.strictObject({ ...Scope, namespace: z.literal("drafted") }),
    profile: z.strictObject({ path: Absolute, dev: z.number().int().nonnegative(), ino: z.number().int().nonnegative(), mode: z.number().int().nonnegative(), ownerFile: Absolute, ownerSha256: Hash }) }),
  z.strictObject({ ...Common, kind: z.literal("clerk-user"), id: z.string().regex(/^user_[A-Za-z0-9]+$/), scope: ClerkScope,
    creation: z.strictObject({ createdAt: z.number().int().nonnegative(), emailDigest: Hash }).nullable() }),
  z.strictObject({ ...Common, kind: z.literal("clerk-session"), id: z.string().regex(/^sess_[A-Za-z0-9]+$/), userId: z.string().regex(/^user_[A-Za-z0-9]+$/), scope: ClerkScope,
    creation: z.strictObject({ createdAt: z.number().int().nonnegative() }).nullable() }),
  z.strictObject({ ...Common, kind: z.literal("browser-auth-entry"), id: z.string().regex(/^[A-Za-z0-9_-]+$/), scope: z.strictObject({ ...Scope, namespace: z.literal("drafted"), keyFile: Absolute, keySha256: Hash }),
    origin: z.url(), usernameDigest: Hash, file: z.strictObject({ path: Absolute, dev: z.number().int().nonnegative(), ino: z.number().int().nonnegative(), mode: z.number().int().nonnegative(), size: z.number().int().nonnegative(), sha256: Hash }) }),
]);
export type CleanupTarget = z.infer<typeof CleanupTarget>;
export function cleanupTargetDigest(target: Omit<CleanupTarget, "identityDigest"> | CleanupTarget) {
  const { identityDigest: _, ...identity } = target as CleanupTarget;
  return cleanupDigest(identity);
}
export const CleanupAdapter = z.enum(["docker", "compose", "runtime", "native", "preview", "endpoint", "browser", "clerk", "vault"]);
export const CleanupObserverResource = z.strictObject({ id: z.string().min(1), key: z.string().min(1), kind: z.string().min(1), purpose: z.string().min(1), externalId: z.string().min(1), state: z.string(), expiresAt: z.string().nullable(), metadata: z.json().nullable() });
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value;
export const cleanupDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const uniqueTargets = (targets: CleanupTarget[]) => new Set(targets.map(target => JSON.stringify([target.kind, Object.entries(target.scope).sort(([a], [b]) => a.localeCompare(b)), target.id]))).size === targets.length;
function retainedEnvironment(input: z.infer<typeof RetainedPreviewInput>, resources: z.infer<typeof CleanupObserverResource>[]) {
  const resource = resources.find(resource => resource.id === input.resourceId);
  if (!resource || resource.externalId !== input.sourcePath || !["directory", "private-directory"].includes(resource.kind) || !["development", "review"].includes(resource.purpose) || resource.key !== `${resource.purpose}-env-directory`) return false;
  const parsed = z.record(z.string(), z.unknown()).safeParse(resource.metadata ?? {}); if (!parsed.success) return false;
  const { observed: _, observedAt: __, ...metadata } = parsed.data;
  const { id, key, kind, purpose, externalId, expiresAt } = resource;
  return cleanupDigest({ id, key, kind, purpose, externalId, expiresAt, metadata }) === input.identityDigest;
}
export const CleanupObserverInput = z.strictObject({ version: z.literal(1), task: z.strictObject({ id: z.string().min(1), primarySessionId: z.string().min(1), worktreePath: Absolute, toolingRevision: z.string().regex(/^[a-f0-9]{40}$/) }),
  resource: CleanupObserverResource, resources: z.array(CleanupObserverResource).min(1).max(1000), stage: z.enum(["prepare", "confirm"]), expectedTargets: z.array(CleanupTarget).min(1).max(1000).optional(), retainedPreviewInputs: z.array(RetainedPreviewInput).min(1).max(100).optional() }).superRefine((input, ctx) => {
    if (input.stage === "prepare" ? input.expectedTargets !== undefined : input.expectedTargets === undefined) ctx.addIssue({ code: "custom", message: "Only confirm requires the exact prepared targets" });
    if (new Set(input.resources.map(resource => resource.id)).size !== input.resources.length || new Set(input.resources.map(resource => resource.key)).size !== input.resources.length || !input.resources.some(resource => resource.id === input.resource.id && cleanupDigest(resource) === cleanupDigest(input.resource))) ctx.addIssue({ code: "custom", message: "Observer resource must occur exactly once in its task inventory" });
    if (input.expectedTargets && (!uniqueTargets(input.expectedTargets) || input.expectedTargets.some(target => target.scope.taskId !== input.task.id || target.scope.purpose !== input.resource.purpose))) ctx.addIssue({ code: "custom", message: "Prepared target scope or uniqueness is invalid" });
    if (input.retainedPreviewInputs && (input.stage !== "confirm" || new Set(input.retainedPreviewInputs.map(value => value.resourceId)).size !== input.retainedPreviewInputs.length
      || input.retainedPreviewInputs.some(value => !retainedEnvironment(value, input.resources)))) ctx.addIssue({ code: "custom", message: "Retained preview inputs require exact confirmation resources" });
  });
export type CleanupObserverInput = z.infer<typeof CleanupObserverInput>;
export const CleanupObserverResult = z.strictObject({ version: z.literal(1), taskId: z.string(), resourceId: z.string(), resourceIdentityDigest: Hash,
  adapter: CleanupAdapter, dependencies: z.array(Nonempty).max(1000), stoppedConsumers: z.array(Nonempty).max(1000), targets: z.array(CleanupTarget).min(1).max(1000), presentTargetDigests: z.array(Hash).max(1000), absent: z.boolean() }).superRefine((result, ctx) => {
    if (new Set(result.dependencies).size !== result.dependencies.length || result.dependencies.includes(result.resourceId)) ctx.addIssue({ code: "custom", message: "Observer dependencies must be unique other resource IDs" });
    if (new Set(result.stoppedConsumers).size !== result.stoppedConsumers.length || result.stoppedConsumers.includes(result.resourceId) || result.stoppedConsumers.some(id => result.dependencies.includes(id))) ctx.addIssue({ code: "custom", message: "Stopped consumers must be unique other resource IDs, separate from full dependencies" });
    if (!uniqueTargets(result.targets) || new Set(result.targets.map(target => target.identityDigest)).size !== result.targets.length || new Set(result.presentTargetDigests).size !== result.presentTargetDigests.length) ctx.addIssue({ code: "custom", message: "Observer targets must be unique" });
    if (result.absent !== (result.presentTargetDigests.length === 0) || result.presentTargetDigests.some(digest => !result.targets.some(target => target.identityDigest === digest && target.presentAtPrepare))) ctx.addIssue({ code: "custom", message: "Observer presence changed outside the prepared target set" });
    if (result.targets.some(target => target.identityDigest !== cleanupTargetDigest(target))) ctx.addIssue({ code: "custom", message: "Observer target digest does not match its exact identity" });
    if (result.targets.some(target => (target.kind === "docker-container" || target.kind === "docker-network") && target.presentAtPrepare && !/^[a-f0-9]{64}$/.test(target.id))) ctx.addIssue({ code: "custom", message: "Present Docker objects require complete IDs" });
    if (result.targets.some(target => target.scope.taskId !== result.taskId || target.kind.startsWith("docker-") && "identity" in target && target.presentAtPrepare !== (target.identity !== null))) ctx.addIssue({ code: "custom", message: "Observer target ownership or initial identity is invalid" });
    if (result.targets.some(target => (target.kind === "clerk-user" || target.kind === "clerk-session") && target.presentAtPrepare && target.creation === null)) ctx.addIssue({ code: "custom", message: "A present Clerk target requires its original provider creation identity" });
  });
export type CleanupObserverResult = z.infer<typeof CleanupObserverResult>;


const ObserverTask = z.strictObject({ id: Nonempty, primarySessionId: Nonempty, worktreePath: Absolute, toolingRevision: z.string().regex(/^[a-f0-9]{40}$/) });
export const CleanupObserverBatchInput = z.strictObject({ version: z.literal(1), task: ObserverTask, resources: z.array(CleanupObserverResource).min(1).max(1000), stage: z.enum(["prepare", "confirm"]),
  retainedPreviewInputs: z.array(RetainedPreviewInput).min(1).max(100).optional(),
  observations: z.array(z.strictObject({ resourceId: Nonempty, expectedTargets: z.array(CleanupTarget).min(1).max(1000).optional() })).min(1).max(1000),
}).superRefine((input, ctx) => {
  if (new Set(input.observations.map(value => value.resourceId)).size !== input.observations.length) ctx.addIssue({ code: "custom", message: "Batch resources must be unique" });
  for (const observation of input.observations) {
    const resource = input.resources.find(value => value.id === observation.resourceId);
    if (!resource || !CleanupObserverInput.safeParse({ version: input.version, task: input.task, resources: input.resources, resource, stage: input.stage, expectedTargets: observation.expectedTargets, retainedPreviewInputs: input.retainedPreviewInputs }).success) ctx.addIssue({ code: "custom", message: "Batch observation does not bind an exact resource and stage" });
  }
});
export type CleanupObserverBatchInput = z.infer<typeof CleanupObserverBatchInput>;
export const CleanupObserverBatchResult = z.strictObject({ version: z.literal(1), taskId: Nonempty, observations: z.array(CleanupObserverResult).min(1).max(1000) }).superRefine((result, ctx) => {
  if (new Set(result.observations.map(value => value.resourceId)).size !== result.observations.length || result.observations.some(value => value.taskId !== result.taskId)) ctx.addIssue({ code: "custom", message: "Batch results must bind unique resources in the same task" });
});
export type CleanupObserverBatchResult = z.infer<typeof CleanupObserverBatchResult>;
