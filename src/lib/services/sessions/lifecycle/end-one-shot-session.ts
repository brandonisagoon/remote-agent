import type { ServerConfig } from "../../../config.ts";
import type { BbClient } from "../../../../types/runtime/index.ts";
import type { AgentIssue } from "../../../../types/sessions/index.ts";
import {
  endSessionGroup,
  terminateBbThreads,
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
  bbClient: BbClient,
  {
    kill,
    killDelayMs = ONE_SHOT_KILL_DELAY_MS,
  }: EndOneShotSessionOptions,
): Promise<EndSessionGroupResult> {
  const group = await endSessionGroup(config, target);
  if (kill && group.bbThreadIds.length > 0) {
    setTimeout(() => {
      void terminateBbThreads(bbClient, group.bbThreadIds).catch(
        (error: unknown) => {
          console.error("Failed to terminate one-shot bb threads:", error);
        },
      );
    }, killDelayMs);
  }
  return group;
}
