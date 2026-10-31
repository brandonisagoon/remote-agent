import path from "node:path";
import { z } from "zod";
import type { CleanupObserverInput, CleanupObserverResource, CleanupObserverResult } from "./cleanup-observer-schema.ts";
import { cleanupDigest } from "./cleanup-observer-schema.ts";

const Sha = z.string().regex(/^[a-f0-9]{64}$/), Prefix = z.string().regex(/^[a-f0-9]{12,64}$/);
const Name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const within = (root: string, file: string) => root === file || file.startsWith(`${root}${path.sep}`);

/** The immutable configured observer verifies the external ownership bytes and
 * physical lifetimes. This pure boundary validates its complete stock plan
 * against the original resource; no filesystem/provider reads occur in SQL. */
export function assertStudioCleanupTargets(result: z.infer<typeof CleanupObserverResult>, resource: z.infer<typeof CleanupObserverResource>, task: CleanupObserverInput["task"]) {
  const targets = result.targets;
  if (!targets.some(target => "studio" in target.scope || target.kind === "studio-proxy-route")) return;
  if (result.adapter !== "compose" || resource.kind !== "docker-compose-project" || resource.purpose !== "development" || result.retainedCompose
    || targets.length !== 10 || targets.some(target => !("studio" in target.scope) || !target.scope.studio || target.scope.taskId !== task.id || target.scope.purpose !== "development"
      || !("project" in target.scope) || target.scope.project !== resource.externalId)) throw new Error("Stock Studio requires its complete original cleanup scope");
  const containers = targets.filter(target => target.kind === "docker-container"), volumes = targets.filter(target => target.kind === "docker-volume"), networks = targets.filter(target => target.kind === "docker-network"), routes = targets.filter(target => target.kind === "studio-proxy-route");
  if (containers.length !== 3 || volumes.length !== 4 || networks.length !== 1 || routes.length !== 2) throw new Error("Stock Studio cleanup has an incomplete member or route set");
  const studio = routes[0]!.scope.studio;
  if (targets.some(target => !("studio" in target.scope) || cleanupDigest(target.scope.studio) !== cleanupDigest(studio))
    || within(task.worktreePath, studio.file) || routes.some(route => within(task.worktreePath, route.scope.configuration.file))) throw new Error("Stock Studio confirmation needs one external immutable ownership proof");
  const metadata = z.object({ composeFile: z.literal(path.join(task.worktreePath, "tools/studio/compose.yaml")),
    containers: z.object({ workspace: z.union([Prefix, z.object({ id: Prefix }).passthrough()]), mysql: z.union([Prefix, z.object({ id: Prefix }).passthrough()]), spatial: z.union([Prefix, z.object({ id: Prefix }).passthrough()]) }).strict(),
    volumes: z.array(Name).length(4), network: z.unknown(),
  }).passthrough().parse(resource.metadata);
  if (metadata.retainedStudio !== undefined || metadata.cutoverReceipt !== undefined) throw new Error("Retained migration resources cannot use stock Studio retirement");
  if ([...containers, ...networks].some(target => !Sha.safeParse(target.id).success) || new Set(metadata.volumes).size !== 4
    || cleanupDigest([...metadata.volumes].sort()) !== cleanupDigest(volumes.map(target => target.id).sort())) throw new Error("Stock Studio targets differ from the original resource identities");
  const memberIds = Object.entries(metadata.containers).map(([service, value]) => {
    const prefix = typeof value === "string" ? value : value.id, matches = containers.filter(target => target.id.startsWith(prefix));
    if (matches.length !== 1) throw new Error("Stock Studio container aliases are ambiguous");
    return { service, id: matches[0]!.id };
  });
  const network = typeof metadata.network === "string" ? /^([a-f0-9]{12,64})(?: \([a-zA-Z0-9][a-zA-Z0-9_.-]*\))?$/.exec(metadata.network)?.[1]
    : z.object({ id: Prefix }).passthrough().parse(metadata.network).id;
  if (new Set(memberIds.map(member => member.id)).size !== 3 || !network || !networks[0]!.id.startsWith(network)) throw new Error("Stock Studio default network or original containers changed");
  const workspace = memberIds.find(member => member.service === "workspace")!.id;
  if (routes.some(route => route.containerId !== workspace || route.scope.proxyId !== routes[0]!.scope.proxyId
    || cleanupDigest(route.scope.configuration) !== cleanupDigest(routes[0]!.scope.configuration)
    || containers.some(container => container.id === route.scope.proxyId) || networks.some(target => target.id === route.scope.proxyId))
    || new Set(routes.map(route => route.id)).size !== 2 || new Set(routes.map(route => route.hostname)).size !== 2
    || cleanupDigest(routes.map(route => route.listenPort).sort()) !== cleanupDigest([3200, 8100])) throw new Error("Stock Studio proxy routes must select the original workspace and shared proxy");
}
