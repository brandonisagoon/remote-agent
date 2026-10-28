import type { ServerConfig } from "../../../../../../lib/config.ts";
import { linearGraphql } from "../../client.ts";

export interface WorkIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: { id: string; name: string; type: string };
  completedAt: string | null;
  parent: { id: string; identifier: string } | null;
  blockedBy: string[];
  blocks: string[];
}
export interface IssueWorkGraph {
  id: string;
  identifier: string;
  children: WorkIssue[];
  states: Array<{ id: string; name: string; type: string }>;
}
type Relation = { type: string; issue: { id: string }; relatedIssue: { id: string } };
type Connection<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
type RawChild = Omit<WorkIssue, "blockedBy" | "blocks"> & {
  relations: Connection<Relation>;
  inverseRelations: Connection<Relation>;
};
type Response = { issue: null | {
  id: string; identifier: string;
  team: { states: { nodes: IssueWorkGraph["states"] } };
  children: Connection<RawChild>;
} };

const QUERY = `query SourceIssueWorkGraph($id: String!, $after: String) {
  issue(id: $id) {
    id identifier team { states { nodes { id name type } } }
    children(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id identifier title url completedAt parent { id identifier }
        state { id name type }
        relations(first: 100) { pageInfo { hasNextPage endCursor } nodes { type issue { id } relatedIssue { id } } }
        inverseRelations(first: 100) { pageInfo { hasNextPage endCursor } nodes { type issue { id } relatedIssue { id } } }
      }
    }
  }
}`;

/** Direct children only. Refuse incomplete dependency graphs instead of
 * silently making scheduling or handoff decisions from truncated results. */
export async function getIssueWorkGraph(config: ServerConfig, query: { id: string }, request = linearGraphql): Promise<IssueWorkGraph> {
  let graph: IssueWorkGraph | undefined;
  let after: string | null = null;
  const cursors = new Set<string>();
  const children = new Set<string>();
  for (let page = 0; page < 10; page++) {
    const { issue }: Response = await request<Response>(config.linearApiKey, QUERY, { id: query.id, after });
    if (!issue) throw new Error("Source issue no longer exists");
    graph ??= { id: issue.id, identifier: issue.identifier, children: [], states: issue.team.states.nodes };
    if (graph.id !== issue.id) throw new Error("Source issue identity changed during graph read");
    for (const child of issue.children.nodes) {
      if (children.has(child.id)) throw new Error("Child graph changed during pagination; retry");
      children.add(child.id);
      if (child.parent?.id !== issue.id) throw new Error("Child parent changed during graph read; retry");
      if (child.relations.pageInfo.hasNextPage || child.inverseRelations.pageInfo.hasNextPage) throw new Error("Child dependency graph exceeds the supported bound; cannot safely reconcile");
      const { relations, inverseRelations, ...details } = child;
      const dependencies = [...relations.nodes, ...inverseRelations.nodes].filter((relation) => relation.type === "blocks");
      graph.children.push({ ...details,
        blockedBy: [...new Set(dependencies.filter((relation) => relation.relatedIssue.id === child.id).map((relation) => relation.issue.id))],
        blocks: [...new Set(dependencies.filter((relation) => relation.issue.id === child.id).map((relation) => relation.relatedIssue.id))],
      });
    }
    if (!issue.children.pageInfo.hasNextPage) return graph;
    after = issue.children.pageInfo.endCursor;
    if (!after || cursors.has(after)) throw new Error("Child pagination did not advance");
    cursors.add(after);
  }
  throw new Error("Issue has more than 1000 direct children; cannot safely reconcile");
}
