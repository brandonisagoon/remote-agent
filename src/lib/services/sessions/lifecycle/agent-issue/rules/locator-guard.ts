import type { BbThread } from "../../../../../../types/runtime/index.ts";
import {
  AgentIssueState,
  type AgentIssue,
  type SessionRuntime,
} from "../../../../../../types/sessions/index.ts";

export interface BbLocator {
  bbThreadId: string;
}

export function locatorConflict(
  existing: AgentIssue,
  registered: SessionRuntime | null,
  incoming: SessionRuntime,
): BbLocator | null {
  if (
    existing.state.name !== AgentIssueState.Connected ||
    !registered?.bbThreadId
  ) {
    return null;
  }
  if (registered.bbThreadId === incoming.bbThreadId) return null;
  return { bbThreadId: registered.bbThreadId };
}

export function threadStillOwnsSession(
  thread: BbThread | null,
  registered: SessionRuntime,
): boolean {
  return Boolean(
    thread &&
      thread.id === registered.bbThreadId &&
      thread.archivedAt == null &&
      thread.status !== "error",
  );
}
