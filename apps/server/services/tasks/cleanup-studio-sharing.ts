import path from "node:path";
import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { FinalizationResourcePlan } from "./finalization-resources.ts";
import { finalizationResourceIdentity } from "./finalization-resources.ts";
import { assertRegisteredPathSharing } from "./cleanup-filesystem.ts";

const Prefix = z.string().regex(/^[a-f0-9]{12,64}$/), Name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const within = (root: string, file: string) => root === file || file.startsWith(`${root}${path.sep}`);
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
type Database = Pick<PrismaClient, "remoteTaskResource" | "remoteTask">;
type Resource = { id: string; key: string; kind: string; purpose: string; externalId: string; state: string; metadata?: unknown; expiresAt?: string | Date | null };
type Selection = { resourceId: string; identityDigest: string; project: string; worktree: string; containers: string[]; volumes: string[]; network: string; proofPaths: string[] };

export function stockStudioMembers(resource: Resource, worktree: string) {
  if (resource.kind !== "docker-compose-project" || resource.purpose !== "development") throw Error("Stock Studio requires its original development Compose resource");
  const metadata = z.object({ composeFile: z.literal(path.join(worktree, "tools/studio/compose.yaml")),
    containers: z.object({ workspace: z.union([Prefix, z.object({ id: Prefix }).passthrough()]), mysql: z.union([Prefix, z.object({ id: Prefix }).passthrough()]), spatial: z.union([Prefix, z.object({ id: Prefix }).passthrough()]) }).strict(),
    volumes: z.array(Name).length(4), network: z.unknown(),
  }).passthrough().parse(resource.metadata);
  if (metadata.retainedStudio !== undefined || metadata.cutoverReceipt !== undefined || new Set(metadata.volumes).size !== 4) throw Error("Retained or ambiguous Studio members cannot receive stock retirement authority");
  const containers = Object.values(metadata.containers).map(value => typeof value === "string" ? value : value.id);
  const network = typeof metadata.network === "string" ? /^([a-f0-9]{12,64})(?: \([a-zA-Z0-9][a-zA-Z0-9_.-]*\))?$/.exec(metadata.network)?.[1] : z.object({ id: Prefix }).passthrough().parse(metadata.network).id;
  if (!network || containers.some((id, index) => containers.some((other, next) => index !== next && (id.startsWith(other) || other.startsWith(id))))) throw Error("Stock Studio original member aliases are ambiguous");
  return { containers, volumes: metadata.volumes, network };
}
function values(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : Object.values(object(value));
  if (items.length > 256) throw Error("Docker ownership member inventory exceeds its bound");
  return items.flatMap(item => typeof item === "string" ? [item] : [object(item).id, object(item).name, object(item).Id, object(item).Name].filter((id): id is string => typeof id === "string"));
}
function networkValues(value: unknown) {
  return values(value).map(candidate => {
    const exact = /^([a-f0-9]{12,64})(?: \([a-zA-Z0-9][a-zA-Z0-9_.-]*\))?$/.exec(candidate);
    if (exact) return exact[1]!;
    if (/^[a-f0-9]{12}/.test(candidate)) throw Error("Registered Docker network identity is ambiguous");
    return candidate;
  });
}
/** Negative registry checks supplement the immutable physical owner proof. Shared
 * proxy/network objects are deliberately absent from this retiring member set. */
export async function assertStudioResourceSharing(prisma: Database, taskId: string, selected: Selection[]) {
  if (!selected.length) return;
  const records = await prisma.remoteTaskResource.findMany({ take: 10001 });
  if (records.length > 10000) throw Error("Studio ownership inventory exceeds its bound");
  for (const own of selected) {
    if (!records.some(record => record.id === own.resourceId)) throw Error("Studio selected resource is missing");
    const ids = [...own.containers, own.network], exact = new Set([own.project, ...own.volumes]);
    for (const record of records) {
      if (record.id === own.resourceId) {
        if (record.taskId !== taskId || record.purpose !== "development" || finalizationResourceIdentity(record).identityDigest !== own.identityDigest) throw Error("Studio selected resource identity changed");
        continue;
      }
      const metadata = object(record.metadata);
      const claims = [record.externalId, ...values(metadata.containers), ...values(metadata.volumes), ...values(metadata.members),
        ...values(metadata.container), ...networkValues(metadata.network), ...values(metadata.containerId), ...values(metadata.dependencyVolume), ...values(metadata.project)];
      if (claims.some(value => exact.has(value) || ids.some(id => Prefix.safeParse(value).success && (value.startsWith(id) || id.startsWith(value))))) throw Error("Stock Studio member or project has another registered owner");
    }
    const scopes = [own.worktree, ...own.proofPaths];
    await assertRegisteredPathSharing(prisma, taskId, scopes);
    const ancestors = new Set<string>();
    for (const scope of scopes) for (let cursor = scope; ; cursor = path.dirname(cursor)) { ancestors.add(cursor); if (cursor === path.dirname(cursor)) break; }
    if (await prisma.remoteTask.findFirst({ where: { id: { not: taskId }, OR: [{ worktreePath: { in: [...ancestors] } }, ...scopes.map(scope => ({ worktreePath: { startsWith: `${scope}${path.sep}` } }))] } })) throw Error("Studio source or proof path has another task owner");
  }
}
export async function assertLegacyStudioScope(prisma: Database & Pick<PrismaClient, "computeEnvironment">, taskId: string, worktree: string, resource: Resource) {
  const members = stockStudioMembers(resource, worktree), identityDigest = finalizationResourceIdentity(resource).identityDigest;
  const environment = await prisma.computeEnvironment.findUnique({ where: { taskId_key: { taskId, key: resource.key } } });
  if (!environment || environment.resourceId !== resource.id || environment.resourceIdentity !== identityDigest || environment.purpose !== "development") throw Error("Stock Studio cleanup requires its exact existing enrollment");
  const configuration = z.object({ configurationFile: z.string().refine(file => path.isAbsolute(file) && path.normalize(file) === file), configurationSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(environment.configuration);
  const directory = path.dirname(configuration.configurationFile);
  if (path.basename(configuration.configurationFile) !== "coverage.json" || within(worktree, directory) || within(directory, worktree)) throw Error("Studio enrollment proof must survive outside its source");
  await assertStudioResourceSharing(prisma, taskId, [{ resourceId: resource.id, identityDigest, project: resource.externalId, worktree, ...members, proofPaths: [directory] }]);
}
export async function assertStudioCleanupSharing(prisma: Database, taskId: string, plan: FinalizationResourcePlan[]) {
  const selected: Selection[] = [];
  for (const entry of plan) {
    if (entry.disposition !== "retire-adapter" || !entry.targets.some(target => "studio" in target.scope)) continue;
    const route = entry.targets.find(target => target.kind === "studio-proxy-route");
    const network = entry.targets.find(target => target.kind === "docker-network");
    if (!route || route.kind !== "studio-proxy-route" || !network) throw Error("Studio prepared member set is unavailable");
    selected.push({ resourceId: entry.id, identityDigest: entry.identityDigest, project: entry.externalId, worktree: entry.observer.task.worktreePath,
      containers: entry.targets.filter(target => target.kind === "docker-container").map(target => target.id), volumes: entry.targets.filter(target => target.kind === "docker-volume").map(target => target.id), network: network.id,
      proofPaths: [path.dirname(route.scope.studio.file)] });
  }
  await assertStudioResourceSharing(prisma, taskId, selected);
}
