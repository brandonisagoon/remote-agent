import { availableParallelism, loadavg } from "node:os";

interface Dependencies {
  probeStore: () => Promise<unknown>;
  now?: () => number;
  schedule?: (callback: () => void, milliseconds: number) => () => void;
  host?: () => { loadAverage: number[]; availableParallelism: number };
}

type ProbeResult = { status: "ok" | "error"; elapsedMs: number };
const STORE_BUDGET_MS = 250;
const LOOP_SAMPLE_MS = 20;

/** On-demand, read-only sampling. A timeout does not cancel a database query:
 * retain and share it until settled so repeated diagnostics cannot queue probes.
 * The timer deadline itself can slip when the event loop is blocked; report that
 * overshoot rather than claiming a hard wall-clock response guarantee. */
export function createControlDiagnostics(dependencies: Dependencies) {
  const now = dependencies.now ?? (() => performance.now());
  const schedule = dependencies.schedule ?? ((callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  });
  const host = dependencies.host ?? (() => ({ loadAverage: loadavg(), availableParallelism: availableParallelism() }));
  let pending: { startedAt: number; result: Promise<ProbeResult> } | undefined;

  return async function snapshot() {
    const startedAt = now();
    const sharedProbe = pending !== undefined;
    if (!pending) {
      const probeStartedAt = now();
      const result = Promise.resolve().then(dependencies.probeStore).then(
        (): ProbeResult => ({ status: "ok", elapsedMs: now() - probeStartedAt }),
        (): ProbeResult => ({ status: "error", elapsedMs: now() - probeStartedAt }),
      );
      const probe = { startedAt: probeStartedAt, result };
      pending = probe;
      void result.then(() => { if (pending === probe) pending = undefined; });
    }
    const probe = pending;
    let cancelDeadline = () => {};
    const deadline = new Promise<{ status: "timeout"; elapsedMs: number }>((resolve) => {
      cancelDeadline = schedule(() => resolve({ status: "timeout", elapsedMs: now() - probe.startedAt }), STORE_BUDGET_MS);
    });
    const loop = new Promise<number>((resolve) => {
      schedule(() => resolve(Math.max(0, now() - startedAt - LOOP_SAMPLE_MS)), LOOP_SAMPLE_MS);
    });
    const [store, schedulingDelayMs] = await Promise.all([
      Promise.race([probe.result, deadline]).finally(() => cancelDeadline()), loop,
    ]);
    const elapsedMs = now() - startedAt;
    return {
      sampledAt: new Date().toISOString(),
      scope: "current-request-window" as const,
      store: { ...store, sharedProbe, budgetMs: STORE_BUDGET_MS },
      eventLoop: { schedulingDelayMs, sampleWindowMs: LOOP_SAMPLE_MS },
      host: host(),
      server: { elapsedMs, deadlineOvershootMs: Math.max(0, elapsedMs - STORE_BUDGET_MS) },
      interpretation: "Compare client round-trip with server elapsed time for transport overhead. This sample does not establish historical cause; a blocked event loop can also delay the store deadline.",
    };
  };
}
