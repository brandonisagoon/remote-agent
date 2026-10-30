import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { assertRequestActive } from "../../request-lifetime.ts";
import { NativeReportInput, NATIVE_REPORT_ORIGIN, nativeReportDigest, readNativeReportOrigin } from "./native-report-origin.ts";

type Store = Pick<PrismaClient, "remoteTask" | "runtimeSession" | "runtimeSessionResourceLink">;
async function ownership(store: Store, config: ServerConfig, taskId: string) {
  assertRequestActive();
  const task = await store.remoteTask.findUniqueOrThrow({ where: { id: taskId } });
  const session = task.primarySessionId && await store.runtimeSession.findUnique({ where: { id: task.primarySessionId } });
  if (!session || task.ownerPaused || task.phase === "closed" || session.status === "closed" || session.role !== "primary" || task.machineId !== config.machine || session.machineId !== task.machineId || session.repositoryId !== task.repositoryId || session.cwd !== task.worktreePath || !task.issueIdentifier || !task.connectionId) throw new Error("Native report requires the current unpaused original task owner");
  const peers = await store.remoteTask.findMany({ where: { machineId: task.machineId, repositoryId: task.repositoryId, connectionId: task.connectionId, issueIdentifier: task.issueIdentifier, phase: { not: "closed" } }, select: { id: true } });
  const links = await store.runtimeSessionResourceLink.findMany({ where: { provider: "linear", connectionId: task.connectionId, resourceType: "issue-identifier", relationship: "handles", externalId: task.issueIdentifier, endedAt: null, runtimeSession: { role: "primary", status: { not: "closed" } } }, orderBy: { id: "asc" } });
  if (peers.length !== 1 || peers[0]!.id !== task.id || links.length !== 1 || links[0]!.runtimeSessionId !== session.id) throw new Error("Native report has no unique original source owner");
  const digest = nativeReportDigest({ task: { id: task.id, primarySessionId: task.primarySessionId, repositoryId: task.repositoryId, machineId: task.machineId, connectionId: task.connectionId, issueIdentifier: task.issueIdentifier, worktreePath: task.worktreePath, branchName: task.branchName, toolingRoot: task.toolingRoot, pinnedToolingRoot: task.pinnedToolingRoot, toolingRevision: task.toolingRevision }, session: { id: session.id, scopeKey: session.scopeKey, cwd: session.cwd, repositoryId: session.repositoryId, machineId: session.machineId, role: session.role }, links });
  return { task, session, digest };
}
export async function inspectNativeReportPublisher(input: { prisma: PrismaClient; config: ServerConfig; taskId: string }) {
  const current = await ownership(input.prisma, input.config, input.taskId);
  return { taskId: current.task.id, sessionId: current.session.id, issueIdentifier: current.task.issueIdentifier, ownershipDigest: current.digest,
    publication: { method: "POST", path: `/api/tasks/${current.task.id}/native-reports`,
      guidance: "For an authorized informational native report, send the body and this ownershipDigest with your native thread/host/turn and a stable requestKey. Use this publisher instead of posting the same report through a separate connector. On an uncertain response, replay the exact request; do not create another comment or ask for a new approval." } };
}

/** Owner-authenticated native reporting uses the existing issue-update outbox and
 * publisher. The native turn is provenance, never a fabricated managed turn. */
export async function publishNativeReport(input: { prisma: PrismaClient; config: ServerConfig; taskId: string; request: z.infer<typeof NativeReportInput> }, delivery?: typeof import("./issue-updates.ts").issueUpdateDelivery) {
  const { prisma, config, taskId } = input;
  const request = NativeReportInput.parse(input.request);
  const current = await ownership(prisma, config, taskId);
  if (current.digest !== request.ownershipDigest) throw new Error("Native report owner changed after inspection");
  const { issueUpdateDelivery, publishSessionIssueUpdate } = await import("./issue-updates.ts");
  const client = delivery ?? issueUpdateDelivery;
  const source = await client.source({ prisma, config, sessionId: current.session.id });
  if (source.session.id !== current.session.id || source.link.connectionId !== current.task.connectionId || source.link.externalId !== current.task.issueIdentifier || source.issue.identifier !== current.task.issueIdentifier) throw new Error("Native report source changed");
  const payload = { requestKey: `native-report:${request.requestKey}`, body: request.body, evidence: [] };
  const prepared = await prisma.$transaction(async tx => {
    if ((await ownership(tx, config, taskId)).digest !== request.ownershipDigest) throw new Error("Native report owner changed during preparation");
    let receipt = await tx.runtimeIssueUpdate.findUnique({ where: { runtimeSessionId_requestKey: { runtimeSessionId: current.session.id, requestKey: payload.requestKey } } });
    if (!receipt) {
      receipt = await tx.runtimeIssueUpdate.create({ data: { id: randomUUID(), runtimeSessionId: current.session.id, requestKey: payload.requestKey, connectionId: source.link.connectionId, issueId: source.issue.id, input: payload, evidence: [] } });
      await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: current.session.id, action: NATIVE_REPORT_ORIGIN, source: "native-report-outbox", key: receipt.id, value: JSON.stringify({ version: 1, taskId, sessionId: current.session.id, repositoryId: current.task.repositoryId, machineId: current.task.machineId, connectionId: source.link.connectionId, issueId: source.issue.id, issueIdentifier: source.issue.identifier, commentId: receipt.id, request }) } });
    }
    const saved = await readNativeReportOrigin(tx, source.link.connectionId, receipt.id);
    if (!saved || saved.origin.taskId !== taskId || nativeReportDigest(saved.origin.request) !== nativeReportDigest(request) || saved.origin.issueId !== source.issue.id) throw new Error("Native report requestKey already belongs to another report");
    assertRequestActive();
    return saved;
  });
  const guard = async () => {
    if ((await ownership(prisma, config, taskId)).digest !== request.ownershipDigest) throw new Error("Native report owner changed before publication");
    const saved = await readNativeReportOrigin(prisma, source.link.connectionId, prepared.receipt.id);
    if (saved?.fingerprint !== prepared.fingerprint) throw new Error("Native report provenance changed before publication");
    assertRequestActive();
  };
  await guard();
  return publishSessionIssueUpdate({ ...payload, prisma, config, sessionId: current.session.id }, { ...client,
    source: async value => { const result = await client.source(value); await guard(); if (result.issue.id !== source.issue.id || result.link.id !== source.link.id) throw new Error("Native report source changed before publication"); return result; },
    read: async (...args) => { const result = await client.read(...args); await guard(); return result; },
    create: async (...args) => { await guard(); const result = await client.create(...args); await guard(); return result; },
    comment: async (...args) => { const result = await client.comment(...args); await guard(); return result; },
  });
}
