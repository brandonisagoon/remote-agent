import { assertRequestActive, enterRequestStage } from "../../request-lifetime.ts";
import { AsyncLocalStorage } from "node:async_hooks";

export type PreparationStage = "source" | "delivery" | "fingerprint" | "retained-archives" | "persistence" | "verification" | "response" | "ownership" | "resource-plan" | "activity-history" | "activity-session" | "activity";
const currentStage = new AsyncLocalStorage<PreparationStage>();
export type PreparationDiagnostic = { stage: PreparationStage; event: "start" | "end"; activeStage: PreparationStage | null; outcome?: "succeeded" | "failed"; failedStage?: PreparationStage; elapsedMs?: number };
const observer = new AsyncLocalStorage<{ record: (value: PreparationDiagnostic) => Promise<void>; failures: Map<unknown, PreparationStage> }>();
export function withPreparationDiagnostics<T>(record: (value: PreparationDiagnostic) => Promise<void>, work: () => Promise<T>): Promise<T> {
  return observer.run({ record, failures: new Map() }, work);
}
export async function preparationStage<T>(stage: PreparationStage, work: () => Promise<T>): Promise<T> {
  assertRequestActive();
  // A dependency wrapper may call an already-instrumented implementation.
  // Count that stage once, even without a persistent preparation observer.
  if (currentStage.getStore() === stage) { const result = await work(); assertRequestActive(); return result; }
  const leave = enterRequestStage(stage), context = observer.getStore(), parent = currentStage.getStore() ?? null;
  const start = performance.now();
  try {
    await context?.record({ stage, event: "start", activeStage: stage });
    let result: T;
    try { result = await currentStage.run(stage, work); assertRequestActive(); }
    catch (error) {
      // Preserve the deepest origin while unwinding this exact error. A caught
      // child error cannot misattribute an unrelated later parent failure.
      const failedStage = context?.failures.get(error) ?? stage;
      context?.failures.set(error, failedStage);
      await context?.record({ stage, event: "end", outcome: "failed", failedStage, activeStage: parent, elapsedMs: Math.round(performance.now() - start) });
      throw error;
    }
    await context?.record({ stage, event: "end", outcome: "succeeded", activeStage: parent, elapsedMs: Math.round(performance.now() - start) });
    return result;
  } finally { leave(); }
}
