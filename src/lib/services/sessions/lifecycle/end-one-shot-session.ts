import type { ServerConfig } from "../../../config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import type { AgentIssue } from "../../../../types/sessions/index.ts";
import {
  endSessionGroup,
  terminateRuntimeSessions,
  type EndSessionGroupResult,
} from "./terminate-session-group.ts";

export const ONE_SHOT_KILL_DELAY_MS = 250;

interface EndOneShotSessionOptions {
  kill: boolean;
  killDelayMs?: number;
}

export async function endOneShotSession(
  config: ServerConfig,
  target: AgentIssue,
  runtime: AgentSessionRuntime,
  {
    kill,
    killDelayMs = ONE_SHOT_KILL_DELAY_MS,
  }: EndOneShotSessionOptions,
): Promise<EndSessionGroupResult> {
  const group = await endSessionGroup(config, target);
  if (kill && group.runtimeSessionIds.length > 0) {
    setTimeout(() => {
      void terminateRuntimeSessions(runtime, group.runtimeSessionIds).catch(
        (error: unknown) => {
          console.error("Failed to terminate one-shot acpx sessions:", error);
        },
      );
    }, killDelayMs);
  }
  return group;
}
