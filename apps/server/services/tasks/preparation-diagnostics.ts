import { assertRequestActive, enterRequestStage } from "../../request-lifetime.ts";
import { AsyncLocalStorage } from "node:async_hooks";

export type PreparationStage = "source" | "delivery" | "fingerprint" | "retained-archives" | "persistence" | "verification" | "response" | "ownership" | "resource-plan" | "activity-history" | "activity-session" | "activity";
const currentStage = new AsyncLocalStorage<PreparationStage>();
const observer = new AsyncLocalStorage<(value: { stage: PreparationStage; event: "start" | "end"; elapsedMs?: number }) => Promise<void>>();
export function withPreparationDiagnostics<T>(record: NonNullable<ReturnType<typeof observer.getStore>>, work: () => Promise<T>): Promise<T> {
  return observer.run(record, work);
}
export async function preparationStage<T>(stage: PreparationStage, work: () => Promise<T>): Promise<T> {
  const leave = enterRequestStage(stage);
  try {
    const record = observer.getStore();
    if (!record || currentStage.getStore() === stage) { const result = await work(); assertRequestActive(); return result; }
    const start = performance.now();
    await record({ stage, event: "start" });
    try { const result = await currentStage.run(stage, work); assertRequestActive(); return result; }
    finally { await record({ stage, event: "end", elapsedMs: Math.round(performance.now() - start) }); }
  } finally { leave(); }
}
