import type { Harness } from "../../../../types/runtime/index.ts";
import { skillInvocation } from "../../../workflows/skills.ts";

export function buildReflectionMessage(
  harness: Harness,
  skill: string,
  cubeIssueIdentifier: string,
  stateName: string,
): string {
  const invocation = skillInvocation(harness, skill);
  if (harness === "claude") {
    return `${invocation} ${cubeIssueIdentifier} — the issue entered ${stateName}. Post the reflection on the issue and keep any follow-up discussion in Linear.`;
  }
  return `Use ${invocation} to post a reflection for ${cubeIssueIdentifier}. The issue entered ${stateName}. Keep any follow-up discussion in Linear.`;
}
