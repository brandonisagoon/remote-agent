export const WorkerRunStatus = {
  Pending: "pending",
  Ignored: "ignored",
  Delivered: "delivered",
  Confirmed: "confirmed",
  Stalled: "stalled",
  Existing: "existing",
  Failed: "failed",
  NoCandidate: "no_candidate",
  Ambiguous: "ambiguous",
  RouterTimeout: "router_timeout",
  Rejected: "rejected",
  StaleTarget: "stale_target",
} as const;

export type WorkerRunStatusValue =
  (typeof WorkerRunStatus)[keyof typeof WorkerRunStatus];

export interface WorkerResult {
  status: WorkerRunStatusValue;
  detail: string | null;
  targetAgentIssueIdentifier: string | null;
}
