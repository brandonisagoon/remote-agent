import path from "node:path";
import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { CleanupObserverInput } from "./cleanup-observer-schema.ts";
import { CleanupObserverCapability, resolveCleanupObserver } from "./cleanup-resource-observer.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";
import { assertDevelopmentIntent, DevelopmentReference } from "./development-intent.ts";

export const LocalServiceStopInput = z.object({ key: z.string().min(1), development: DevelopmentReference.optional() }).strict();
export const LocalServiceStopAuthority = z.object({
  version: z.literal(1), authorityDigest: z.string().regex(/^[a-f0-9]{64}$/), task: CleanupObserverInput.shape.task,
  turn: z.object({ requestId: z.string().min(1), lifecycleRevision: z.number().int().positive() }).strict().optional(),
  development: DevelopmentReference.optional(),
  resource: z.object({ id: z.string().min(1), key: z.string().min(1), kind: z.literal("local-http"), purpose: z.enum(["development", "review"]), externalId: z.string().min(1), expiresAt: z.string().nullable(), identityDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  resources: z.array(z.object({ id: z.string(), key: z.string(), identityDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(2).max(1000),
  capability: CleanupObserverCapability,
}).strict().refine(value => Boolean(value.turn) !== Boolean(value.development), "Local service stop requires exactly one current execution witness");
export type LocalServiceStopAuthority = z.infer<typeof LocalServiceStopAuthority>;
type Context = { prisma: PrismaClient; config: ServerConfig; runtime: Pick<AgentSessionRuntime, "observeSessionActivity">; sessionId: string; key: string; development?: z.infer<typeof DevelopmentReference> };

/** Stop only: original primary/current execution plus a configured immutable
 * process capability. This neither prepares cleanup nor changes any receipt. */
export async function resolveLocalServiceStopAuthority(input: Context, resolve = resolveCleanupObserver): Promise<LocalServiceStopAuthority> {
  LocalServiceStopInput.parse({ key: input.key, ...(input.development ? { development: input.development } : {}) });
  const inspect = async () => {
    const task = await input.prisma.remoteTask.findUnique({ where: { primarySessionId: input.sessionId } });
    const session = await input.prisma.runtimeSession.findUnique({ where: { id: input.sessionId } });
    if (!task || !session || session.role !== "primary" || session.status === "closed" || !input.development && session.status !== "active" || !task.worktreePath
      || session.cwd !== task.worktreePath || session.repositoryId !== task.repositoryId || session.machineId !== task.machineId
      || task.machineId !== input.config.machine) throw new Error("Local service stop requires the active original task primary");
    if ((!input.development && task.ownerPaused) || task.phase === "closed") throw new Error("Local service stop task is paused or closed");
    if (input.development) {
      const intent = await assertDevelopmentIntent({ ...input, ...input.development, taskId: task.id });
      if (intent.intent.action !== "stop") throw new Error("Local service authority only accepts development stop intent");
    }
    const repository = input.config.repositories[task.repositoryId];
    if (!repository?.tooling) throw new Error("Local service stop has no configured cleanup capability");
    let linkId: string | null = null;
    if (task.issueIdentifier) {
      if (!task.connectionId || !input.config.connections[task.connectionId]) throw new Error("Local service stop task connection is unavailable");
      const link = await input.prisma.runtimeSessionResourceLink.findFirst({ where: { runtimeSessionId: session.id, provider: "linear", connectionId: task.connectionId,
        resourceType: "issue-identifier", externalId: task.issueIdentifier, relationship: "handles", endedAt: null } });
      if (!link) throw new Error("Local service stop source ownership was revoked");
      linkId = link.id;
    }
    const resource = await input.prisma.remoteTaskResource.findUnique({ where: { taskId_key: { taskId: task.id, key: input.key } } });
    if (!resource || resource.kind !== "local-http" || resource.state === "released" || !["development", "review"].includes(resource.purpose)) throw new Error("Local service stop requires an exact existing app receipt");
    if (input.development && resource.purpose !== "development") throw new Error("Development intent cannot stop review services");
    const metadata = z.record(z.string(), z.unknown()).parse(resource.metadata ?? {});
    const pidFile = z.string().refine(file => path.isAbsolute(file) && path.normalize(file) === file).parse(metadata.pidFile);
    const environment = path.dirname(pidFile), role = path.basename(pidFile, ".pid");
    if (!environment.split(path.sep).includes(task.id) || !["api", "web", "posthog"].includes(role)
      || (role === "posthog" ? metadata.script !== "scripts/posthog-fixture.ts" : metadata.start !== `run.sh ${role}`)) throw new Error("Local service has no supported task launcher correspondence");
    const endpoint = new URL(resource.externalId);
    if (!["http:", "https:"].includes(endpoint.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) || !endpoint.port || endpoint.username || endpoint.password) throw new Error("Local service endpoint is not exact loopback");
    const records = await input.prisma.remoteTaskResource.findMany({ where: { taskId: task.id } });
    const groups = records.filter(record => ["docker-compose", "docker-compose-project"].includes(record.kind) && record.purpose === resource.purpose && record.state !== "released"
      && (record.metadata as { composeFile?: unknown } | null)?.composeFile === path.join(environment, "compose.yml"));
    if (groups.length !== 1) throw new Error("Local service has no unique recorded launcher environment");
    const members = records.filter(record => record.id === groups[0]!.id || ["local-http", "local-process"].includes(record.kind) && record.purpose === resource.purpose
      && typeof (record.metadata as { pidFile?: unknown } | null)?.pidFile === "string" && path.dirname((record.metadata as { pidFile: string }).pidFile) === environment);
    if (members.some(record => record.state === "released")) throw new Error("Local service family contains a retired endpoint");
    const resources = members.map(record => { const identity = finalizationResourceIdentity(record); return { id: record.id, key: record.key, identityDigest: identity.identityDigest }; }).sort((a, b) => a.id.localeCompare(b.id));
    const others = await input.prisma.remoteTaskResource.findMany({ where: { id: { not: resource.id }, state: { not: "released" }, kind: { in: ["local-http", "local-process", "docker-compose", "docker-compose-project"] } }, take: 10_001 });
    if (others.length > 10_000 || others.some(other => {
      const meta = other.metadata && typeof other.metadata === "object" && !Array.isArray(other.metadata) ? other.metadata : {};
      if (meta.pidFile === pidFile) return true;
      if (other.taskId !== task.id && (meta.composeFile === path.join(environment, "compose.yml") || other.externalId === groups[0]!.externalId)) return true;
      try { const url = new URL(other.externalId); return ["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.port === endpoint.port; } catch { return false; }
    })) throw new Error("Local service endpoint, PID file or environment is shared");
    let turn: { requestId: string; lifecycleRevision: number } | undefined;
    if (!input.development) {
      const lifecycle = await input.prisma.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: session.id }, orderBy: { sequence: "desc" } });
      const activity = input.runtime.observeSessionActivity?.(session.id);
      if (activity?.state !== "executing" || !activity.requestId || lifecycle?.phase !== "started" || lifecycle.requestId !== activity.requestId) throw new Error("Local service stop requires the current executing primary turn");
      turn = { requestId: activity.requestId, lifecycleRevision: lifecycle.sequence };
    }
    const identity = finalizationResourceIdentity(resource);
    const stable = finalizationDigest({ task: { id: task.id, repositoryId: task.repositoryId, machineId: task.machineId, connectionId: task.connectionId,
      issueIdentifier: task.issueIdentifier, branchName: task.branchName, baseCommit: task.baseCommit, primarySessionId: task.primarySessionId,
      worktreePath: task.worktreePath, toolingRoot: task.toolingRoot, toolingRevision: task.toolingRevision, pinnedToolingRoot: task.pinnedToolingRoot, phase: task.phase },
      repository: { root: repository.root, tooling: repository.tooling }, linkId, identity, resources, state: resource.state, turn, ...(input.development ? { development: input.development } : {}) });
    return { task, identity, resources, turn, stable };
  };
  const before = await inspect();
  const capability = await resolve({ task: before.task, config: input.config });
  const after = await inspect();
  if (before.stable !== after.stable) throw new Error("Local service stop task, resource or execution changed during capability resolution");
  return LocalServiceStopAuthority.parse({ version: 1, authorityDigest: after.stable, task: { id: after.task.id, primarySessionId: after.task.primarySessionId,
    worktreePath: after.task.worktreePath, toolingRevision: after.task.toolingRevision }, ...(after.turn ? { turn: after.turn } : { development: input.development }), resource: after.identity, resources: after.resources, capability });
}
