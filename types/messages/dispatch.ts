import type { WorkerResult } from "../dispatcher/worker-run.ts";
import type { RouteDecision } from "../sessions/selection.ts";

export type MessageDispatchResult = WorkerResult & {
  decision: RouteDecision | null;
};
