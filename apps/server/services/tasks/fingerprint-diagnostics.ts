import { AsyncLocalStorage } from "node:async_hooks";

type Operation = "head" | "branch" | "status" | "deleted-files" | "file-list" | "metadata" | "hash";
type Counts = { files?: number; chunk?: number; completedFiles?: number };
type Active = Counts & { scan: number; operation: Operation; started: number };
export type FingerprintDiagnostic = { diagnostic: "preparation-fingerprint"; worker: string; acceptedRevision: number; processId: number;
  event: "worker-start" | "heartbeat" | "step-start" | "step-end" | "worker-settled" | "journal-terminal"; terminalState?: "ready" | "failed"; terminalRevision?: number; elapsedMs: number;
  scan?: number; operation?: Operation; operationElapsedMs?: number; outcome?: "returned" | "threw"; files?: number; chunk?: number; completedFiles?: number };
type Context = { scans: number; active?: Active; emit(event: Omit<FingerprintDiagnostic, "diagnostic" | "worker" | "acceptedRevision" | "processId" | "elapsedMs">): void };
const context = new AsyncLocalStorage<Context>();

/** Private, bounded facts only. No paths, arguments, file contents, errors or
 * credentials enter this log. A heartbeat proves the process is scheduling,
 * never that the pending operation progressed or cleanup was authorized. */
export async function withFingerprintDiagnostics<T>(binding: { worker: string; acceptedRevision: number }, work: () => Promise<T>,
  options: { record?: (event: FingerprintDiagnostic) => void; heartbeatMs?: number } = {}): Promise<T> {
  const started = performance.now();
  const state: Context = { scans: 0, emit(event) {
    try { (options.record ?? (value => console.error(JSON.stringify(value))))({ diagnostic: "preparation-fingerprint", ...binding,
      processId: process.pid, elapsedMs: Math.round(performance.now() - started), ...event }); } catch { /* Diagnostics never replace verification. */ }
  } };
  const timer = setInterval(() => {
    const active = state.active;
    state.emit({ event: "heartbeat", ...(active ? { scan: active.scan, operation: active.operation, files: active.files, chunk: active.chunk, completedFiles: active.completedFiles, operationElapsedMs: Math.round(performance.now() - active.started) } : {}) });
  }, options.heartbeatMs ?? 30_000);
  timer.unref();
  state.emit({ event: "worker-start" });
  let outcome: "returned" | "threw" = "threw";
  try { const result = await context.run(state, work); outcome = "returned"; return result; }
  finally { clearInterval(timer); state.emit({ event: "worker-settled", outcome }); }
}

export async function fingerprintScan<T>(work: (step: <R>(operation: Operation, counts: Counts, read: () => Promise<R>) => Promise<R>) => Promise<T>): Promise<T> {
  const state = context.getStore();
  const scan = state ? ++state.scans : 0;
  return work(async (operation, counts, read) => {
    if (!state) return read();
    const active = { scan, operation, ...counts, started: performance.now() };
    const previous = state.active;
    state.active = active;
    state.emit({ event: "step-start", scan, operation, ...counts });
    let outcome: "returned" | "threw" = "threw";
    try { const result = await read(); outcome = "returned"; return result; }
    finally {
      state.emit({ event: "step-end", scan, operation, ...counts, outcome, operationElapsedMs: Math.round(performance.now() - active.started) });
      state.active = previous;
    }
  });
}

/** Called only after the journal write/transaction has committed. */
export function fingerprintWorkerTerminal(terminalState: "ready" | "failed", terminalRevision: number) {
  context.getStore()?.emit({ event: "journal-terminal", terminalState, terminalRevision });
}
