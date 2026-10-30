import { AsyncLocalStorage } from "node:async_hooks";

export type PreparationStage = "source" | "delivery" | "fingerprint" | "retained-archives" | "persistence" | "verification" | "response";
const currentStage = new AsyncLocalStorage<PreparationStage>();
const observer = new AsyncLocalStorage<(value: { stage: PreparationStage; event: "start" | "end"; elapsedMs?: number }) => Promise<void>>();
export function withPreparationDiagnostics<T>(record: NonNullable<ReturnType<typeof observer.getStore>>, work: () => Promise<T>): Promise<T> {
  return observer.run(record, work);
}
export async function preparationStage<T>(stage: PreparationStage, work: () => Promise<T>): Promise<T> {
  const record = observer.getStore();
  if (!record || currentStage.getStore() === stage) return work();
  const start = performance.now();
  await record({ stage, event: "start" });
  try { return await currentStage.run(stage, work); }
  finally { await record({ stage, event: "end", elapsedMs: Math.round(performance.now() - start) }); }
}
