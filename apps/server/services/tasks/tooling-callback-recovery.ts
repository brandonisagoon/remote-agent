import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { SERVER_INSTANCE, attemptRecords, recordInterruptedAttempt } from "./tooling-operations.ts";
import { markToolingOperationInterrupted } from "./tooling-releases.ts";

/**
 * Boot recovery of tooling callbacks interrupted by a server process's exit.
 * Runs once after runtime ownership is acquired and before any runtime,
 * worker or listener starts.
 *
 * A crash leaves an attempt in one of two windows: (1) its `intent` without
 * any result while the operation is `running`, or (2) its `unknown` result
 * recorded but the operation still `running`. Either blocks reconciliation and
 * settlement forever. An attempt is repaired only when its intent's stamp
 * names a DIFFERENT server instance on THIS host whose PID provably exited
 * (ESRCH). Unstamped, current-instance, other-host, live, reused or uncertain
 * PIDs, and malformed or truncated history, leave the operation blocked with
 * a diagnosis. Repair is one transaction: the attempt's exact `unknown`
 * result is appended (window 1), then `running -> unknown` (both windows).
 * Nothing is replayed, no success is inferred, and admission, producer,
 * consumer, offer, slot and instruction records are never touched; an
 * unknown operation recovers only through its existing reconciliation.
 */
export type PidState = "exited" | "alive" | "uncertain";
export const probePid = (pid: number): PidState => {
  try { process.kill(pid, 0); return "alive"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "exited" : "uncertain"; }
};
const Stamp = z.strictObject({ instance: z.string().uuid(), pid: z.number().int().positive(), host: z.string().min(1) });
type Instance = { instance: string; pid: number; host: string };
export type CallbackRecoveryReport = {
  repaired: Array<{ operationId: string; attempts: string[]; status: "unknown" }>;
  blocked: Array<{ operationId: string; reason: string }>;
};
const PAGE = 200, OPERATION_BOUND = 10_000;

export async function recoverInterruptedCallbacks(input: { prisma: PrismaClient; current?: Instance; probe?: (pid: number) => PidState }): Promise<CallbackRecoveryReport> {
  const current = input.current ?? SERVER_INSTANCE, probe = input.probe ?? probePid;
  const report: CallbackRecoveryReport = { repaired: [], blocked: [] };
  let cursor: string | undefined, seen = 0;
  for (;;) {
    const page = await input.prisma.toolingOperation.findMany({ where: { status: { in: ["running", "unknown"] } }, orderBy: { id: "asc" }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) });
    for (const operation of page) {
      if (++seen > OPERATION_BOUND) { report.blocked.push({ operationId: operation.id, reason: `more than ${OPERATION_BOUND} open operations; recovery stopped here` }); return report; }
      try {
        const outcome = await recoverOperation(input.prisma, operation, current, probe);
        if (outcome && "reason" in outcome) report.blocked.push({ operationId: operation.id, reason: outcome.reason });
        else if (outcome) report.repaired.push({ operationId: operation.id, attempts: outcome.attempts, status: "unknown" });
      } catch (error) { report.blocked.push({ operationId: operation.id, reason: error instanceof Error ? error.message : String(error) }); }
    }
    if (page.length < PAGE) return report;
    cursor = page.at(-1)!.id;
  }
}

type Operation = { id: string; status: string; sessionId: string; taskId: string };
async function recoverOperation(prisma: PrismaClient, operation: Operation, current: Instance, probe: (pid: number) => PidState): Promise<{ reason: string } | { attempts: string[] } | null> {
  const records = await attemptRecords(prisma, operation, operation.id); // overflow throws: blocked
  const malformed = records.find(record => !record.value);
  if (malformed) return { reason: `malformed attempt record ${malformed.sequence}` };
  const values = records.map(record => ({ ...record.value!, sequence: record.sequence }));
  if (values.some(value => value.operationId !== operation.id)) return { reason: "attempt records name another operation" };
  const intents = values.filter(value => value.state === "intent");
  const results = (attemptId: string) => values.filter(value => value.attemptId === attemptId && value.state !== "intent" && value.state !== "reconciled").map(value => value.state);
  // Window 1: an intent without any result. Window 2: an unknown result while still running.
  const resultless = intents.filter(intent => !results(intent.attemptId).length);
  const unknownWhileRunning = operation.status === "running" ? intents.filter(intent => results(intent.attemptId).includes("unknown")) : [];
  const candidates = [...resultless, ...unknownWhileRunning];
  if (!candidates.length) return null;
  const evidence: string[] = [];
  for (const intent of candidates) {
    const stamp = Stamp.safeParse((intent as { server?: unknown }).server);
    if (!stamp.success) return { reason: `attempt ${intent.attemptId} has no server instance stamp` };
    if (stamp.data.instance === current.instance) return { reason: `attempt ${intent.attemptId} belongs to this running server instance` };
    if (stamp.data.host !== current.host) return { reason: `attempt ${intent.attemptId} ran on another host (${stamp.data.host})` };
    if (stamp.data.pid === current.pid) return { reason: `attempt ${intent.attemptId} names this process's PID ${stamp.data.pid} (reused)` };
    const state = probe(stamp.data.pid);
    if (state !== "exited") return { reason: `attempt ${intent.attemptId} server PID ${stamp.data.pid} is ${state}` };
    evidence.push(`interrupted-by-restart:${stamp.data.instance}:${stamp.data.pid}`);
  }
  await prisma.$transaction(async tx => {
    // Under the write lock (first write below): the history and status must be
    // exactly what was proven; anything else rolls back.
    const latest = await tx.toolingOperation.findUnique({ where: { id: operation.id } });
    if (!latest || latest.status !== operation.status) throw new Error(`operation is now ${latest?.status ?? "missing"}`);
    for (const [index, intent] of resultless.entries()) await recordInterruptedAttempt(tx, operation, intent, evidence[index]!);
    const again = await attemptRecords(tx, operation, operation.id);
    if (again.length !== records.length + resultless.length || again.slice(resultless.length).some((record, index) => record.sequence !== records[index]!.sequence)) throw new Error("attempt history changed during recovery");
    if (operation.status === "running") await markToolingOperationInterrupted(tx, { operationId: operation.id });
  });
  return { attempts: candidates.map(intent => intent.attemptId) };
}
