import { createHash } from "node:crypto";
import type { PrismaClient } from "../../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../../types/runtime/index.ts";
import { issueUpdateDelivery, publishSessionIssueUpdate } from "../issue-updates.ts";
import { listRuntimeProjectionRetries, resolveRuntimeProjectionRetry, runRuntimeProjectionAttempt } from "./projection-retries.ts";

const scans = new WeakMap<PrismaClient, number>();
const PREFIX = "task-stall:v1:";
const graceMs = 60_000;
type Input = { prisma: PrismaClient; config: ServerConfig; runtime: AgentSessionRuntime };
type Signal = { kind: "instruction" | "question" | "result" | "projection"; sessionId: string; id: string; since: string; cause: string };
const terminal = (issue: { state: { type: string } }) => ["completed", "canceled"].includes(issue.state.type);
const eligible = { controlMode: "agent", phase: { notIn: ["complete", "closed"] }, environmentStatus: { not: "stopped" } };

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
      const primary = await prisma.runtimeSession.findUnique({ where: { id: task.primarySessionId! } });
      if (!primary || primary.status === "closed" || primary.role !== "primary" || primary.cwd !== task.worktreePath || primary.machineId !== task.machineId || primary.repositoryId !== task.repositoryId) continue;
      const links = await prisma.runtimeSessionResourceLink.findMany({ where: { runtimeSessionId: primary.id, provider: "linear", resourceType: "issue-identifier", relationship: "handles", endedAt: null } });
      const link = links[0];
      if (links.length !== 1 || !link || task.connectionId && task.connectionId !== link.connectionId || task.issueIdentifier && task.issueIdentifier !== link.externalId) continue;
      const children = await prisma.runtimeSession.findMany({ where: { role: "delegate", cwd: primary.cwd, machineId: primary.machineId, repositoryId: primary.repositoryId, outgoingRelations: { some: { targetSessionId: primary.id, relationship: "spawned-by", endedAt: null } } } });
      const sessionIds = [primary.id, ...children.filter((row) => row.status !== "closed").map((row) => row.id)];
      const [instructions, questions, notifications, retries] = await Promise.all([
        prisma.runtimeInstruction.findMany({ where: { sessionId: { in: sessionIds }, state: "unknown" }, select: { id: true, sessionId: true, updatedAt: true } }),
        prisma.runtimeQuestion.findMany({ where: { runtimeSessionId: { in: sessionIds }, state: "unknown" }, select: { id: true, runtimeSessionId: true, updatedAt: true } }),
        prisma.runtimeSessionRelation.findMany({ where: { sourceSessionId: { in: children.map((row) => row.id) }, targetSessionId: primary.id, relationship: "notifies-parent", endedAt: null } }),
        listRuntimeProjectionRetries(prisma, [primary.id, ...children.map((row) => row.id)]),
      ]);
      const signals: Signal[] = [
        ...instructions.map((row) => ({ kind: "instruction" as const, sessionId: row.sessionId, id: row.id, since: row.updatedAt.toISOString(), cause: "Instruction delivery is unconfirmed; inspect the old writer before explicitly resolving or retrying it." })),
        ...questions.map((row) => ({ kind: "question" as const, sessionId: row.runtimeSessionId, id: row.id, since: row.updatedAt.toISOString(), cause: "Owner-question delivery is unconfirmed; reconcile the original question receipt." })),
      ];
      if (notifications.length) {
        const events = await prisma.runtimeLifecycleEvent.findMany({ where: { runtimeSessionId: { in: notifications.map((row) => row.sourceSessionId) }, phase: { in: ["completed", "failed", "cancelled"] }, occurredAt: { lte: new Date(at - graceMs) } }, select: { id: true, runtimeSessionId: true, occurredAt: true } });
        const receipts = await prisma.runtimeInstruction.findMany({ where: { sessionId: primary.id, id: { in: events.map((row) => `delegate-result:${primary.id}:${row.id}`) } }, select: { id: true, state: true, updatedAt: true } });
        const byId = new Map(receipts.map((row) => [row.id, row]));
        for (const event of events) {
          const receipt = byId.get(`delegate-result:${primary.id}:${event.id}`);
          if (receipt && receipt.state !== "failed") continue; // queued is not failed; unknown is already reported above
          signals.push({ kind: "result", sessionId: event.runtimeSessionId, id: event.id, since: (receipt?.updatedAt ?? event.occurredAt).toISOString(), cause: receipt ? "A terminal delegate result reached the primary inbox, but its delivery turn failed." : "A terminal delegate result is journaled but has no primary inbox receipt." });
        }
      }
      for (const retry of retries) {
        if (retry.stage === "stall" || retry.state !== "exhausted") continue;
        signals.push({ kind: "projection", sessionId: retry.sessionId, id: `${retry.stage}:${retry.eventId}`, since: new Date(retry.failedAt).toISOString(), cause: `${retry.stage === "notify" ? "Delegate-result notification" : "Source-update publication"} exhausted ${retry.attempts} automatic delivery attempts; explicit projection recovery is required.` });
      }
      signals.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const requestKey = PREFIX + createHash("sha256").update(JSON.stringify([task.id, link.connectionId, link.externalId, signals])).digest("hex");
      for (const retry of retries) {
        if (retry.stage === "stall" && retry.eventId.startsWith(PREFIX) && (!signals.length || retry.eventId !== requestKey)) await resolveRuntimeProjectionRetry(prisma, retry, now);
      }
      if (!signals.length) continue;
      const receipt = await prisma.runtimeIssueUpdate.findUnique({ where: { runtimeSessionId_requestKey: { runtimeSessionId: primary.id, requestKey } } });
      if (receipt?.published) continue;
      const body = [
        "### Delivery needs attention",
        ...signals.slice(0, 5).map((signal) => `- ${signal.cause} Since ${signal.since}. Session \`${signal.sessionId}\`; ${signal.kind} \`${signal.id}\`.`),
        ...(signals.length > 5 ? [`${signals.length - 5} additional delivery signals are retained in task activity.`] : []),
        `Inspect task \`${task.id}\` activity and delivery receipts before recovery. No instruction was replayed.`,
      ].join("\n\n");
      await runRuntimeProjectionAttempt(prisma, { sessionId: primary.id, eventId: requestKey, stage: "stall" }, async () => {
        // Recheck local control/ownership immediately before any external write.
        const stillOwned = async () => {
          const current = await prisma.remoteTask.findFirst({ where: { id: task.id, ...eligible, primarySessionId: primary.id, worktreePath: primary.cwd, repositoryId: primary.repositoryId, machineId: primary.machineId, connectionId: task.connectionId, issueIdentifier: task.issueIdentifier } });
          const currentLinks = await prisma.runtimeSessionResourceLink.findMany({ where: { runtimeSessionId: primary.id, provider: "linear", resourceType: "issue-identifier", relationship: "handles", endedAt: null } });
          return Boolean(current && currentLinks.length === 1 && currentLinks[0]?.id === link.id && currentLinks[0].externalId === link.externalId && currentLinks[0].connectionId === link.connectionId);
        };
        if (!await stillOwned()) return;
        const source = await client.source({ ...input, sessionId: primary.id });
        if (source.link.id !== link.id || source.link.externalId !== link.externalId || source.link.connectionId !== link.connectionId || terminal(source.issue)) return;
        await publishSessionIssueUpdate({ ...input, sessionId: primary.id, requestKey, body, evidence: [] }, {
          ...client,
          source: async () => source,
          read: async (scopedConfig, query) => {
            const latest = await client.read(scopedConfig, query);
            if (!await stillOwned()) throw new Error("Stall publication stopped: task control or source ownership changed");
            if (latest && terminal(latest)) throw new Error("Stall publication stopped: linked source issue is terminal");
            return latest;
          },
        });
      }, now);
    } catch (error) {
      // Publication must never block another task's delivery or execution.
      console.error(`[task-stalls] Unable to inspect task ${task.id}:`, error);
    }
  }
}
