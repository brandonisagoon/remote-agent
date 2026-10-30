import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { IssueWorkGraph } from "../../integrations/linear/session-store/source-issue/work-graph.ts";
import { getIssueWorkGraph } from "../../integrations/linear/session-store/source-issue/work-graph.ts";
import { linkedSourceIssue } from "./questions.ts";
import { WORK_MAP, WorkMapInput, SavedWorkMap, savedWorkMap, workMapIdentity } from "../tasks/work-map-state.ts";
import { ExternalBinding, externalDigest } from "../tasks/external-delivery-schema.ts";
import { CompletionDelivery } from "../tasks/finalization-receipts.ts";

export { WorkMapInput } from "../tasks/work-map-state.ts";
type Context = { prisma: PrismaClient; config: ServerConfig; sessionId: string };
const client = { source: linkedSourceIssue, graph: getIssueWorkGraph };
async function owned(input: Context, prisma = input.prisma) {
  const task = await prisma.remoteTask.findUniqueOrThrow({ where: { primarySessionId: input.sessionId } });
  const session = await prisma.runtimeSession.findUniqueOrThrow({ where: { id: input.sessionId } });
  if (task.ownerPaused || task.phase === "closed" || session.status === "closed" || session.role !== "primary" || task.machineId !== input.config.machine
    || session.cwd !== task.worktreePath || session.repositoryId !== task.repositoryId || session.machineId !== task.machineId) throw new Error("Only the open unpaused original primary may change its work map");
  return task;
}
function membership(graph: IssueWorkGraph, map: WorkMapInput) {
  const allowed = new Set([graph.id, ...graph.children.map(c => c.id)]);
  if (map.units.some(u => !allowed.has(u.issueId)) || map.remainingConsumers.some(c => !allowed.has(c.issueId)) || !map.units.some(u => u.issueId === graph.id)) throw new Error("Work map must name the source and only current direct children");
}

/** Planning metadata, not owner approval or delivery evidence. Append-only
 * request replay/CAS uses the existing metadata journal and original identity. */
export async function recordWorkMap(input: Context & { map: WorkMapInput }, delivery = client) {
  const map = WorkMapInput.parse(input.map);
  const task = await owned(input);
  const source = await delivery.source(input);
  const graph = await delivery.graph(source.config, { id: source.issue.id });
  if (graph.id !== source.issue.id || source.link.connectionId !== task.connectionId || source.issue.identifier !== task.issueIdentifier) throw new Error("Work map source ownership changed");
  membership(graph, map);
  const saved = SavedWorkMap.parse({ identity: workMapIdentity(task), sourceIssueId: graph.id, input: map });
  // Re-read remote membership before the local CAS; no remote writes or sessions.
  const refreshed = await delivery.graph(source.config, { id: graph.id });
  if (refreshed.id !== graph.id) throw new Error("Work map source changed during observation");
  membership(refreshed, map);
  return input.prisma.$transaction(async tx => {
    const current = await owned(input, tx as PrismaClient);
    if (JSON.stringify(workMapIdentity(current)) !== JSON.stringify(saved.identity)) throw new Error("Work map task identity changed during observation");
    const link = await tx.runtimeSessionResourceLink.findFirst({ where: { runtimeSessionId: input.sessionId, provider: "linear", connectionId: task.connectionId!, resourceType: "issue-identifier", externalId: task.issueIdentifier!, relationship: "handles", endedAt: null } });
    if (!link) throw new Error("Work map source link is no longer active");
    const where = { runtimeSessionId: input.sessionId, source: `work-map:${task.id}`, action: WORK_MAP };
    const prior = await tx.runtimeMetadataEvent.findFirst({ where: { ...where, key: map.requestKey } });
    const value = JSON.stringify(saved);
    if (prior) {
      if (prior.value !== value) throw new Error("Work map requestKey belongs to different scope");
      return { revision: prior.sequence, map, replayed: true };
    }
    const latest = await tx.runtimeMetadataEvent.findFirst({ where, orderBy: { sequence: "desc" } });
    if ((latest?.sequence ?? 0) !== map.expectedRevision) throw new Error("Work map changed; read it before updating scope");
    const event = await tx.runtimeMetadataEvent.create({ data: { ...where, key: map.requestKey, value } });
    return { revision: event.sequence, map, replayed: false };
  });
}

export async function workMapProjection(input: Context, graph: IssueWorkGraph) {
  const task = await input.prisma.remoteTask.findUnique({ where: { primarySessionId: input.sessionId } });
  const stored = task && await savedWorkMap(input.prisma, task);
  if (!stored) return { mapping: null, unmappedIssueIds: [graph.id, ...graph.children.map(c => c.id)] };
  const map = stored.saved.input;
  const currentIds = new Set([graph.id, ...graph.children.map(c => c.id)]);
  const staleIssueIds = map.units.filter(u => !currentIds.has(u.issueId)).map(u => u.issueId);
  if (stored.saved.sourceIssueId !== graph.id) throw new Error("Work map source issue changed");
  const where = { runtimeSessionId: input.sessionId, source: `owner:${task.id}` };
  const [bindingEvent, contract, revoked, events] = await Promise.all([
    input.prisma.runtimeMetadataEvent.findFirst({ where: { ...where, action: "external-delivery-binding" }, orderBy: { sequence: "desc" } }),
    input.prisma.runtimeMetadataEvent.findFirst({ where: { ...where, action: "completion-contract" }, orderBy: { sequence: "desc" } }),
    input.prisma.runtimeMetadataEvent.findFirst({ where: { ...where, action: "delivered-retirement-revoked" }, orderBy: { sequence: "desc" } }),
    input.prisma.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: input.sessionId, source: `observer:${task.id}`, action: "completion-observation" }, orderBy: { sequence: "desc" }, take: 100 }),
  ]);
  const parsed = bindingEvent && ExternalBinding.safeParse(JSON.parse(bindingEvent.value ?? "null"));
  const candidate = parsed && parsed.success ? parsed.data : null;
  const identity = candidate?.identity;
  const contractValue = JSON.parse(contract?.value ?? "null");
  const binding = candidate && identity?.taskId === task.id && identity.sessionId === input.sessionId && identity.repositoryId === task.repositoryId
    && identity.machineId === task.machineId && identity.connectionId === task.connectionId && identity.issueIdentifier === task.issueIdentifier
    && identity.taskWorktree === task.worktreePath && identity.branch === task.branchName && identity.baseCommit === task.baseCommit
    && identity.toolingRoot === task.toolingRoot && identity.toolingRevision === task.toolingRevision && identity.pinnedToolingRoot === task.pinnedToolingRoot
    && candidate.acceptance.issueId === graph.id && externalDigest(candidate.input) === candidate.manifestDigest
    && (!revoked || revoked.sequence < bindingEvent!.sequence) && (candidate.version === 2 || candidate.contractRevision === contract?.sequence && contractValue?.boundary === "merge") ? candidate : null;
  const deliveries = map.deliveries.map(delivery => {
    const ref = delivery.pullRequest;
    const accepted = ref && binding?.deliveries.find(d => {
      const scope = binding.input.deliveries.find(value => value.id === d.id);
      return d.repository === ref.repository && d.pullRequest === ref.number && d.reviewedHead === ref.head
        && (!delivery.proposed || scope?.branch === delivery.proposed.branch && scope?.baseBranch === delivery.proposed.baseBranch);
    });
    const latestSingle = events.find(e => CompletionDelivery.shape.receipts.safeParse(JSON.parse(e.value ?? "null")).data?.contractRevision === contract?.sequence);
    const latestReceipt = latestSingle && CompletionDelivery.shape.receipts.parse(JSON.parse(latestSingle.value!));
    const singleEvent = ref && latestReceipt && contractValue?.boundary !== "revoked" && latestReceipt.snapshot.head === ref.head
      && latestReceipt.snapshot.branch === task.branchName && latestReceipt.commit.observed && latestReceipt.commit.sha === ref.head
      && (!delivery.proposed || latestReceipt.snapshot.branch === delivery.proposed.branch && contractValue?.baseBranch === delivery.proposed.baseBranch && contractValue?.repository === delivery.proposed.repository)
      && latestReceipt.pullRequest.observed && latestReceipt.pullRequest.matchesHead && latestReceipt.pullRequest.url?.toLowerCase() === `https://github.com/${ref.repository}/pull/${ref.number}` ? latestSingle : null;
    const single = singleEvent ? CompletionDelivery.shape.receipts.parse(JSON.parse(singleEvent.value!)) : null;
    const facts = { pullRequest: Boolean(accepted || single), review: accepted ? null : single?.review.approved ?? null,
      merge: Boolean(accepted || single?.merge.observed && single.merge.merged && single.merge.sha), deployed: null };
    const verified = Boolean(accepted || single && single.snapshot.clean && single.commit.clean
      && (contractValue?.verificationRequired === false || single.verification.matched)
      && (!contractValue?.reviewRequired || single.review.observed && single.review.approved));
    return { ...delivery, observation: accepted ? { source: "accepted-external-delivery" as const, revision: bindingEvent!.sequence, observedAt: bindingEvent!.occurredAt } : singleEvent ? { source: "completion-observation" as const, revision: singleEvent.sequence, observedAt: singleEvent.occurredAt } : null,
      facts, boundaryObserved: verified && (delivery.boundary === "pr" ? facts.pullRequest && Boolean(accepted || single?.push.matchesHead) : delivery.boundary === "review" ? facts.review === true && Boolean(single?.push.matchesHead) : delivery.boundary === "merge" ? facts.merge : false) };
  });
  return { mapping: { revision: stored.revision, ...map, deliveries, staleIssueIds, authority: "none" as const }, unmappedIssueIds: [...currentIds].filter(id => !map.units.some(u => u.issueId === id)) };
}

export async function assertMappedIssueDelivery(input: Context, graph: IssueWorkGraph, issueId: string) {
  const projection = await workMapProjection(input, graph);
  const map = projection.mapping;
  const unit = map?.units.find(u => u.issueId === issueId);
  // Old/unmapped children preserve DRA34 semantics; work items finish from
  // their acceptance evidence without a separate merge or teardown ceremony.
  if (!map || !unit || unit.kind === "work-item") return;
  const required = new Set(unit.deliveryIds);
  const addDependencies = (id: string) => { for (const next of map.deliveries.find(d => d.id === id)!.dependsOn) if (!required.has(next)) { required.add(next); addDependencies(next); } };
  for (const id of [...required]) addDependencies(id);
  if (map.staleIssueIds.length || [...required].some(id => !map.deliveries.find(d => d.id === id)?.boundaryObserved)) throw new Error("Mapped delivery boundary is unobserved; implementation or child counts do not establish shipping");
}
