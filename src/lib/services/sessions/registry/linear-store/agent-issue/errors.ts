export class AgentIssueNotFoundError extends Error {
  constructor(agentIssueId: string) {
    super(`Linear Agents issue not found: ${agentIssueId}`);
    this.name = "AgentIssueNotFoundError";
  }
}
