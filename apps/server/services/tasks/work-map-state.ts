import { z } from "zod";
import type { PrismaClient, RemoteTask } from "../../../../generated/prisma/client.ts";

export const WORK_MAP = "task-work-map";
const Id = z.string().trim().min(1).max(200);
const Key = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
const Text = z.string().trim().min(1).max(2000);
const Repository = z.string().regex(/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/);
export const WorkMapInput = z.object({
  version: z.literal(1), requestKey: Id, expectedRevision: z.number().int().nonnegative(),
  units: z.array(z.object({ issueId: Id, kind: z.enum(["outcome", "deliverable", "work-item"]), acceptance: Text, deliveryIds: z.array(Key).max(30) }).strict()).min(1).max(101),
  deliveries: z.array(z.object({ id: Key, scope: Text, boundary: z.enum(["pr", "review", "merge", "deployed"]), dependsOn: z.array(Key).max(30), stackedOn: Key.optional(),
    proposed: z.object({ repository: Repository, branch: Id, baseBranch: Id }).strict().optional(),
    pullRequest: z.object({ repository: Repository, number: z.number().int().positive(), head: z.string().regex(/^[a-f0-9]{40}$/) }).strict().optional(),
  }).strict()).max(30),
  remainingConsumers: z.array(z.object({ issueId: Id, reason: Text }).strict()).max(101),
}).strict().superRefine((map, ctx) => {
  const unique = (values: string[]) => new Set(values).size === values.length;
  const ids = new Set(map.deliveries.map(d => d.id));
  const refs = map.deliveries.flatMap(d => d.pullRequest ? [`${d.pullRequest.repository}/${d.pullRequest.number}`] : []);
  if (!unique(map.units.map(u => u.issueId)) || !unique([...map.deliveries.map(d => d.id)]) || !unique(refs) || !unique(map.remainingConsumers.map(c => c.issueId))) ctx.addIssue({ code: "custom", message: "Work, delivery, PR and consumer identities must be unique" });
  for (const u of map.units) if (!unique(u.deliveryIds) || u.deliveryIds.some(id => !ids.has(id)) || u.kind === "deliverable" && !u.deliveryIds.length) ctx.addIssue({ code: "custom", message: "Mapped deliveries must exist and be unique; deliverables require a delivery boundary" });
  const complete = new Set<string>();
  const visit = (id: string, chain: Set<string>): boolean => {
    if (complete.has(id)) return true;
    if (chain.has(id)) return false;
    const delivery = map.deliveries.find(d => d.id === id);
    const valid = Boolean(delivery && delivery.dependsOn.every(next => visit(next, new Set([...chain, id]))));
    if (valid) complete.add(id);
    return valid;
  };
  for (const d of map.deliveries) {
    if (!unique(d.dependsOn) || !visit(d.id, new Set())) ctx.addIssue({ code: "custom", message: "Delivery dependencies must exist and be acyclic" });
    if (d.stackedOn) {
      const base = map.deliveries.find(value => value.id === d.stackedOn);
      if (!d.dependsOn.includes(d.stackedOn) || !d.proposed || !base?.proposed || d.proposed.repository !== base.proposed.repository || d.proposed.baseBranch !== base.proposed.branch) ctx.addIssue({ code: "custom", message: "A PR stack requires its exact same-repository base branch and dependency" });
    }
    if (d.proposed && d.pullRequest && d.proposed.repository !== d.pullRequest.repository) ctx.addIssue({ code: "custom", message: "Observed PR reference must match its proposed repository" });
  }
});
export type WorkMapInput = z.infer<typeof WorkMapInput>;
const Identity = z.object({ taskId: Id, sessionId: Id, repositoryId: Id, machineId: Id, connectionId: Id.nullable(), issueIdentifier: Id.nullable(),
  worktree: z.string().nullable(), branch: z.string(), baseCommit: z.string().nullable(), toolingRoot: z.string(), toolingRevision: z.string(), pinnedToolingRoot: z.string().nullable() }).strict();
export function workMapIdentity(task: RemoteTask) {
  return Identity.parse({ taskId: task.id, sessionId: task.primarySessionId, repositoryId: task.repositoryId, machineId: task.machineId, connectionId: task.connectionId, issueIdentifier: task.issueIdentifier,
    worktree: task.worktreePath, branch: task.branchName, baseCommit: task.baseCommit, toolingRoot: task.toolingRoot, toolingRevision: task.toolingRevision, pinnedToolingRoot: task.pinnedToolingRoot });
}
export const SavedWorkMap = z.object({ identity: Identity, sourceIssueId: Id, input: WorkMapInput }).strict();
type Store = Pick<PrismaClient, "runtimeMetadataEvent">;
export async function savedWorkMap(prisma: Store, task: RemoteTask) {
  if (!task.primarySessionId) return null;
  const event = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: `work-map:${task.id}`, action: WORK_MAP }, orderBy: { sequence: "desc" } });
  if (!event) return null;
  const saved = SavedWorkMap.parse(JSON.parse(event.value ?? "null"));
  if (JSON.stringify(saved.identity) !== JSON.stringify(workMapIdentity(task))) throw new Error("Work map belongs to a changed original task identity");
  return { revision: event.sequence, saved };
}

/** An explicit shared-use hold only. No map or an unmapped legacy issue adds
 * no prerequisite. Child state/counts never imply an environment consumer. */
export async function assertNoRemainingConsumers(prisma: Store, task: RemoteTask) {
  const map = await savedWorkMap(prisma, task);
  if (map?.saved.input.remainingConsumers.length) throw new Error("The task environment still has explicitly recorded work consumers; reconcile its work map before cleanup");
}
