import { renderWorkflowPrompt } from "../../../workflows/repository.ts";

export function buildReflectionMessage(
  prompt: string,
  sourceIssueIdentifier: string,
  stateName: string,
): string {
  return renderWorkflowPrompt(prompt, {
    sourceIssueIdentifier,
    sourceIssueState: stateName,
  });
}
