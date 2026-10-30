import path from "node:path";
import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { CleanupObserverInput } from "./cleanup-observer-schema.ts";
import { CleanupObserverCapability, resolveCleanupObserver } from "./cleanup-resource-observer.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";

export const BrowserStopInput = z.object({ key: z.string().min(1) }).strict();
export const BrowserStopAuthority = z.object({
  version: z.literal(1), task: CleanupObserverInput.shape.task,
  turn: z.object({ requestId: z.string().min(1), lifecycleRevision: z.number().int().positive() }).strict(),
  resource: z.object({ id: z.string().min(1), key: z.string().min(1), kind: z.literal("browser-profile"), purpose: z.enum(["browser", "review"]), externalId: z.string().min(1), expiresAt: z.string().nullable(), identityDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  capability: CleanupObserverCapability,
}).strict();
export type BrowserStopAuthority = z.infer<typeof BrowserStopAuthority>;
type Context = { prisma: PrismaClient; config: ServerConfig; runtime: Pick<AgentSessionRuntime, "observeSessionActivity">; sessionId: string; key: string };
const within = (root: string, file: string) => root === file || file.startsWith(`${root}${path.sep}`);

/** Stop only: original primary/current execution plus a configured immutable
 * browser capability. This neither prepares cleanup nor changes any receipt. */
export async function resolveBrowserStopAuthority(input: Context, resolve = resolveCleanupObserver): Promise<BrowserStopAuthority> {
  BrowserStopInput.parse({ key: input.key });
  const inspect = async () => {
    const task = await input.prisma.remoteTask.findUnique({ where: { primarySessionId: input.sessionId } });
    const session = await input.prisma.runtimeSession.findUnique({ where: { id: input.sessionId } });
    if (!task || !session || session.role !== "primary" || session.status !== "active" || !task.worktreePath
      || session.cwd !== task.worktreePath || session.repositoryId !== task.repositoryId || session.machineId !== task.machineId
      || task.machineId !== input.config.machine) throw new Error("Browser stop requires the active original task primary");
    if (task.ownerPaused || task.phase === "closed") throw new Error("Browser stop task is paused or closed");
    const repository = input.config.repositories[task.repositoryId];
    if (!repository?.tooling) throw new Error("Browser stop has no configured cleanup capability");
    let linkId: string | null = null;
    if (task.issueIdentifier) {
      if (!task.connectionId || !input.config.connections[task.connectionId]) throw new Error("Browser stop task connection is unavailable");
      const link = await input.prisma.runtimeSessionResourceLink.findFirst({ where: { runtimeSessionId: session.id, provider: "linear", connectionId: task.connectionId,
        resourceType: "issue-identifier", externalId: task.issueIdentifier, relationship: "handles", endedAt: null } });
      if (!link) throw new Error("Browser stop source ownership was revoked");
      linkId = link.id;
    }
    const resource = await input.prisma.remoteTaskResource.findUnique({ where: { taskId_key: { taskId: task.id, key: input.key } } });
    if (!resource || resource.kind !== "browser-profile" || resource.state === "released" || !["browser", "review"].includes(resource.purpose)
      || !path.isAbsolute(resource.externalId) || path.normalize(resource.externalId) !== resource.externalId || path.basename(resource.externalId) !== "profile") throw new Error("Browser stop requires an exact existing profile receipt");
    const metadata = z.record(z.string(), z.unknown()).parse(resource.metadata);
    const expectedSession = resource.key === "browser-profile" && resource.purpose === "browser" ? task.id
      : resource.key === "browser-profile:review" && resource.purpose === "review" ? `${task.id}-review` : null;
    if (!expectedSession || metadata.namespace !== "drafted" || metadata.session !== expectedSession
      || metadata.ownerFile !== path.join(path.dirname(resource.externalId), "profile-owner.json")
      || !z.string().regex(/^[a-f0-9]{64}$/).safeParse(metadata.ownerSha256).success) throw new Error("Browser stop profile does not name its exact original task session");
    // Check registered sharing on every renewal, including another task's
    // containing directory. The client independently validates real paths,
    // private marker/profile identity and named-session ownership before close.
    const others = await input.prisma.remoteTaskResource.findMany({ where: { id: { not: resource.id }, state: { not: "released" },
      OR: [{ kind: "browser-profile" }, { externalId: { startsWith: path.sep } }] }, take: 10_001 });
    if (others.length > 10_000 || others.some(other => {
      const meta = other.metadata && typeof other.metadata === "object" && !Array.isArray(other.metadata) ? other.metadata : {};
      return other.kind === "browser-profile" && (other.externalId === resource.externalId || meta.namespace === "drafted" && meta.session === expectedSession)
        || other.taskId !== task.id && path.isAbsolute(other.externalId) && (within(other.externalId, resource.externalId) || within(resource.externalId, other.externalId));
    })) throw new Error("Browser stop profile or named session is shared with another resource");
    const lifecycle = await input.prisma.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: session.id }, orderBy: { sequence: "desc" } });
    const activity = input.runtime.observeSessionActivity?.(session.id);
    if (activity?.state !== "executing" || !activity.requestId || lifecycle?.phase !== "started" || lifecycle.requestId !== activity.requestId) throw new Error("Browser stop requires the current executing primary turn");
    const turn = { requestId: activity.requestId, lifecycleRevision: lifecycle.sequence };
    const identity = finalizationResourceIdentity(resource);
    const stable = finalizationDigest({ task: { id: task.id, repositoryId: task.repositoryId, machineId: task.machineId, connectionId: task.connectionId,
      issueIdentifier: task.issueIdentifier, branchName: task.branchName, baseCommit: task.baseCommit, primarySessionId: task.primarySessionId,
      worktreePath: task.worktreePath, toolingRoot: task.toolingRoot, toolingRevision: task.toolingRevision, pinnedToolingRoot: task.pinnedToolingRoot, phase: task.phase },
      repository: { root: repository.root, tooling: repository.tooling }, linkId, identity, state: resource.state, turn });
    return { task, identity, turn, stable };
  };
  const before = await inspect();
  const capability = await resolve({ task: before.task, config: input.config });
  const after = await inspect();
  if (before.stable !== after.stable) throw new Error("Browser stop task, resource or execution changed during capability resolution");
  return BrowserStopAuthority.parse({ version: 1, task: { id: after.task.id, primarySessionId: after.task.primarySessionId,
    worktreePath: after.task.worktreePath, toolingRevision: after.task.toolingRevision }, turn: after.turn, resource: after.identity, capability });
}
