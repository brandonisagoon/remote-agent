import { createHash } from "node:crypto";
import { canonicalPublicationReceipt, observePublicationRecoveries, readPublicationFact, resolveTaskPublication, reserveTaskPublication, type TaskPublication } from "../task-publication.ts";
import type { PrismaClient } from "../../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../../types/runtime/index.ts";
import { IssueUpdateInput, issueUpdateDelivery, publishSessionIssueUpdate } from "../issue-updates.ts";
import { listRuntimeProjectionRetries, resolveRuntimeProjectionRetry, runRuntimeProjectionAttempt } from "./projection-retries.ts";

const scans = new WeakMap<PrismaClient, number>();
const graceMs = 60_000;
type Input = { prisma: PrismaClient; config: ServerConfig; runtime: AgentSessionRuntime };
type Signal = { kind: "instruction" | "question" | "result" | "projection" | "operation"; sessionId: string; id: string; since: string; cause: string };
const terminal = (issue: { state: { type: string } }) => ["completed", "canceled"].includes(issue.state.type);
const eligible = { ownerPaused: false, phase: { notIn: ["complete", "closed"] }, environmentStatus: { not: "stopped" } };

/** Low-frequency, receipt-driven publication only. Queued work, absent local
 * liveness and elapsed time alone are not proof of a stall. This never starts
 * a turn, changes issue state, or retries an ambiguous provider instruction. */
export async function projectTaskStalls(input: Input, client = issueUpdateDelivery, now: () => number = Date.now) {
  const { prisma, config } = input;
  const at = now();
  if (at - (scans.get(prisma) ?? -Infinity) < 30_000) return;
  scans.set(prisma, at);
  const tasks = await prisma.remoteTask.findMany({ where: { ...eligible, machineId: config.machine, primarySessionId: { not: null } } });
  for (const task of tasks) {
    try {
      const primary = await prisma.runtimeSession.findUnique({ where: { id: task.primarySessionId! }, include: { sessionMirror: true } });
      if (!primary || primary.status === "closed" || primary.role !== "primary" || primary.cwd !== task.worktreePath || primary.machineId !== task.machineId || primary.repositoryId !== task.repositoryId) continue;
      const links = await prisma.runtimeSessionResourceLink.findMany({ where: { runtimeSessionId: primary.id, provider: "linear", resourceType: "issue-identifier", relationship: "handles", endedAt: null } });
      if (links.length > 1 || !links.length && !primary.sessionMirror) continue;
      const source = await client.source({ ...input, sessionId: primary.id });
      const link = links[0] ?? source.link;
      if ( task.connectionId && task.connectionId !== link.connectionId || task.issueIdentifier && task.issueIdentifier !== link.externalId) continue;
      const children = await prisma.runtimeSession.findMany({ where: { role: "delegate", machineId: primary.machineId, repositoryId: primary.repositoryId, outgoingRelations: { some: { targetSessionId: primary.id, relationship: "spawned-by", endedAt: null } } } });
      const sessionIds = [primary.id, ...children.filter((row) => row.status !== "closed").map((row) => row.id)];
      const [instructions, questions, notifications, retries] = await Promise.all([
        prisma.runtimeInstruction.findMany({ where: { sessionId: { in: sessionIds }, OR: [{ state: "unknown" }, { sessionId: primary.id, state: "failed" }], NOT: { id: { startsWith: "delegate-result:" } } }, select: { id: true, sessionId: true, state: true, updatedAt: true } }),
        prisma.runtimeQuestion.findMany({ where: { runtimeSessionId: { in: sessionIds }, state: "unknown" }, select: { id: true, runtimeSessionId: true, updatedAt: true } }),
        prisma.runtimeSessionRelation.findMany({ where: { sourceSessionId: { in: children.map((row) => row.id) }, targetSessionId: primary.id, relationship: "notifies-parent", endedAt: null } }),
        listRuntimeProjectionRetries(prisma, [primary.id, ...children.map((row) => row.id)]),
      ]);
      const signals: Signal[] = [
        ...instructions.map((row) => ({ kind: "instruction" as const, sessionId: row.sessionId, id: row.id, since: row.updatedAt.toISOString(), cause: row.state === "unknown" ? "Instruction delivery is unconfirmed; inspect the old writer before explicitly resolving or retrying it." : "An accepted instruction failed. Inspect its original result before recovery." })),
        ...questions.map((row) => ({ kind: "question" as const, sessionId: row.runtimeSessionId, id: row.id, since: row.updatedAt.toISOString(), cause: "Owner-question delivery is unconfirmed; reconcile the original question receipt." })),
      ];
      if (notifications.length) {
        const events = await prisma.runtimeLifecycleEvent.findMany({ where: { runtimeSessionId: { in: notifications.map((row) => row.sourceSessionId) }, phase: { in: ["completed", "failed", "cancelled"] }, occurredAt: { lte: new Date(at - graceMs) } }, select: { id: true, runtimeSessionId: true, occurredAt: true } });
        const receipts = await prisma.runtimeInstruction.findMany({ where: { sessionId: primary.id, id: { in: events.map((row) => `delegate-result:${primary.id}:${row.id}`) } }, select: { id: true, state: true, updatedAt: true } });
        const byId = new Map(receipts.map((row) => [row.id, row]));
        for (const event of events) {
          const receipt = byId.get(`delegate-result:${primary.id}:${event.id}`);
          if (receipt && !["failed", "unknown"].includes(receipt.state)) continue; // Queued is not failed; the result has its own durable subject.
          signals.push({ kind: "result", sessionId: event.runtimeSessionId, id: event.id, since: (receipt?.updatedAt ?? event.occurredAt).toISOString(), cause: receipt ? "A terminal delegate result reached the primary inbox, but its delivery turn failed." : "A terminal delegate result is journaled but has no primary inbox receipt." });
        }
      }
      for (const retry of retries) {
        if (retry.stage === "stall" || retry.state !== "exhausted") continue;
        signals.push({ kind: "projection", sessionId: retry.sessionId, id: `${retry.stage}:${retry.eventId}`, since: new Date(retry.failedAt).toISOString(), cause: `${retry.stage === "notify" ? "Delegate-result notification" : "Source-update publication"} exhausted automatic delivery attempts; explicit projection recovery is required.` });
      }
      const stillOwned = async () => {
        const current = await prisma.remoteTask.findFirst({ where: { id: task.id, ...eligible, primarySessionId: primary.id, worktreePath: primary.cwd, repositoryId: primary.repositoryId, machineId: primary.machineId, connectionId: task.connectionId, issueIdentifier: task.issueIdentifier } });
        const currentLinks = await prisma.runtimeSessionResourceLink.findMany({ where: { runtimeSessionId: primary.id, provider: "linear", resourceType: "issue-identifier", relationship: "handles", endedAt: null } });
        if (!links.length) {
          if (!current || currentLinks.length || (await prisma.runtimeSession.findUnique({ where: { id: primary.id } }))?.sessionMirrorId !== primary.sessionMirrorId) return false;
          const currentSource = await client.source({ ...input, sessionId: primary.id });
          return currentSource.link.id === link.id && currentSource.link.externalId === link.externalId && currentSource.link.connectionId === link.connectionId && currentSource.issue.id === source.issue.id;
        }
        return Boolean(current && currentLinks.length === 1 && currentLinks[0]?.id === link.id && currentLinks[0].externalId === link.externalId && currentLinks[0].connectionId === link.connectionId);
      };
      if (!await stillOwned() || source.link.id !== link.id || source.link.externalId !== link.externalId || source.link.connectionId !== link.connectionId || terminal(source.issue)) continue;
      const owner = { sessionId: primary.id, taskId: task.id, repositoryId: task.repositoryId, machineId: task.machineId, connectionId: link.connectionId, issueId: source.issue.id };
      const scopedClient = { ...client, source: async () => source, read: async (scopedConfig: Parameters<typeof client.read>[0], query: Parameters<typeof client.read>[1]) => {
        const latest = await client.read(scopedConfig, query);
        if (!await stillOwned()) throw new Error("Stall publication stopped: task identity or source ownership changed");
        if (latest && terminal(latest)) throw new Error("Stall publication stopped: linked source issue is terminal");
        return latest;
      } };
      // Resume reserved outbox entries before observing newer transitions. A
      // lost acknowledgement keeps its original payload and comment UUID.
      const pending = await prisma.runtimeIssueUpdate.findMany({ where: { runtimeSessionId: primary.id, connectionId: owner.connectionId, issueId: owner.issueId, published: false,
        OR: [{ requestKey: { startsWith: "task-publication:v1:" } }, { requestKey: { startsWith: "task-stall:v1:" } }] }, orderBy: { createdAt: "asc" }, take: 100 });
      for (const receipt of pending) {
        await runRuntimeProjectionAttempt(prisma, { sessionId: primary.id, eventId: `publication-outbox:${receipt.id}`, stage: "stall" }, async () => {
          if (!await stillOwned()) return;
          const payload = IssueUpdateInput.parse(receipt.input);
          await publishSessionIssueUpdate({ ...input, sessionId: primary.id, ...payload }, scopedClient);
          for (const retry of retries) if (retry.stage === "stall" && retry.eventId === receipt.requestKey) await resolveRuntimeProjectionRetry(prisma, retry, now);
          if (receipt.requestKey.startsWith("task-stall:v1:") && payload.body.startsWith("### Delivery needs attention\n\n")) {
            // Decode only the old server's literal subject fields. This is a
            // one-time outbox migration, not a prose similarity/identity rule.
            const references = [...payload.body.matchAll(/Session `([^`]+)`; (instruction|question|result|projection) `([^`]+)`\./g)].slice(0, 5);
            for (const [, sessionId, kind, id] of references) {
              const subject = kind === "projection" ? { kind: "projection" as const, id: id!.slice(id!.indexOf(":") + 1), sessionId: sessionId!, stage: id!.startsWith("notify:") ? "notify" as const : "project" as const }
                : { kind: kind as "instruction" | "question" | "result", id: id! };
              const fact = await readPublicationFact(prisma, owner, subject);
              if (fact.status !== "blocked" || !fact.code) continue;
              const confirmed = await prisma.runtimeIssueUpdate.findUniqueOrThrow({ where: { id: receipt.id } });
              await reserveTaskPublication(prisma, owner, { ...payload, requestKey: `legacy-stall:${receipt.id}:${createHash("sha256").update(JSON.stringify(subject)).digest("hex")}`, publication: { category: "blocker", subject, code: fact.code } }, confirmed.evidence!, confirmed);
            }
          }
        }, now);
      }
      const publications: Array<{ publication: TaskPublication; body: string }> = (await observePublicationRecoveries(prisma, owner)).map((publication) => ({ publication,
        body: `Earlier blocker resolved for ${publication.subject.kind} \`${publication.subject.id}\`. The original failure and recovery evidence remain in task activity.` }));
      const operations = await prisma.toolingOperation.findMany({ where: { taskId: task.id, sessionId: primary.id, status: { in: ["running", "unknown"] } }, take: 1000 });
      signals.push(...operations.map((row) => ({ kind: "operation" as const, sessionId: primary.id, id: row.id, since: "", cause: "A task tooling operation failed or has an unconfirmed result. Inspect its original attempt and recovery evidence." })));
      for (const signal of signals) {
        const subject: TaskPublication["subject"] = signal.kind === "projection"
          ? { kind: "projection", id: signal.id.slice(signal.id.indexOf(":") + 1), sessionId: signal.sessionId, stage: signal.id.startsWith("notify:") ? "notify" : "project" }
          : { kind: signal.kind, id: signal.id };
        const fact = await readPublicationFact(prisma, owner, subject);
        if (fact.status !== "blocked" || !fact.code) continue;
        publications.push({ publication: { category: "blocker", subject, code: fact.code } as TaskPublication,
          body: `### Delivery needs attention\n\n${signal.cause}\n\nInspect task \`${task.id}\`, ${signal.kind} \`${signal.id}\`, and its original delivery evidence. No instruction was replayed.` });
      }
      for (const item of publications) {
        const identified = await prisma.$transaction((tx) => resolveTaskPublication(tx, owner, item.publication));
        const requestKey = "task-stall:v2:" + createHash("sha256").update(identified.requestKey).digest("hex");
        const receipt = await canonicalPublicationReceipt(prisma, owner, identified.requestKey);
        if (receipt?.published) {
          for (const retry of retries) if (retry.stage === "stall" && retry.eventId === requestKey) await resolveRuntimeProjectionRetry(prisma, retry, now);
          continue;
        }
        await runRuntimeProjectionAttempt(prisma, { sessionId: primary.id, eventId: requestKey, stage: "stall" }, async () => {
          if (!await stillOwned()) return;
          await publishSessionIssueUpdate({ ...input, sessionId: primary.id, ...(receipt ? IssueUpdateInput.parse(receipt.input) : { requestKey, body: item.body, publication: identified.publication, evidence: [] }) }, scopedClient);
        }, now);
      }

    } catch (error) {
      // Publication must never block another task's delivery or execution.
      console.error(`[task-stalls] Unable to inspect task ${task.id}:`, error);
    }
  }
}
