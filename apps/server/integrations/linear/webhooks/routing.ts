import type { ServerConfig, WebhookConfig } from "../../../../../lib/config.ts";
import { linearGraphql } from "../client.ts";

/** Reaction/comment deliveries can omit their issue's team. Resolve that
 * metadata only after all identity predicates match, then apply the complete
 * subscription again at the caller. Never infer a missing actor from an issue. */
export async function completeLinearRouting(config: ServerConfig, webhook: WebhookConfig, attributes: Record<string, string | undefined>, issueId?: string) {
  const metadata = new Set(["linear.teamId", "linear.teamKey", "linear.projectId"]);
  const conditions = Object.values(webhook.repositoryRouting).flatMap((rule) => rule.when ?? []);
  const needsMetadata = conditions.some((condition) =>
    Object.keys(condition).some((key) => metadata.has(key) && !attributes[key]) &&
    Object.entries(condition).every(([key, values]) => metadata.has(key) || (attributes[key] != null && values.includes(attributes[key]!))),
  );
  if (!needsMetadata || !issueId) return attributes;
  const connection = config.connections[webhook.connectionId];
  if (!connection) throw new Error("Linear connection missing");
  const result = await linearGraphql<{ issue: { team: { id: string; key: string; organization: { id: string } }; project: { id: string } | null } | null }>(connection.apiKey,
    "query RoutingIssue($id: String!) { issue(id: $id) { team { id key organization { id } } project { id } } }", { id: issueId });
  if (!result.issue || result.issue.team.organization.id !== attributes["linear.organizationId"]) return attributes;
  return { ...attributes, "linear.teamId": result.issue.team.id, "linear.teamKey": result.issue.team.key, "linear.projectId": result.issue.project?.id };
}
