import { expect, test } from "bun:test";
import { testConfig } from "../../../../../../test-support/config.ts";
import { linearGraphql } from "../../client.ts";
import { getIssueWorkGraph } from "./work-graph.ts";

const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
function child(id: string, parentId = "parent") {
  return { id, identifier: `DRA-${id}`, title: id, url: `https://linear.app/${id}`, completedAt: null,
    parent: { id: parentId, identifier: "DRA-28" }, state: { id: "todo", name: "Todo", type: "unstarted" },
    relations: empty, inverseRelations: empty };
}

test("direct-child pagination preserves dependency direction and current state", async () => {
  const seen: unknown[] = [];
  const relation = { type: "blocks", issue: { id: "29" }, relatedIssue: { id: "31" } };
  const request = (async (_auth, _query, variables) => {
    seen.push(variables);
    const next = (variables as { after: string | null }).after;
    return { issue: { id: "parent", identifier: "DRA-28", team: { states: { nodes: [] } }, children: {
      nodes: next ? [{ ...child("31"), inverseRelations: { ...empty, nodes: [relation] } }] : [{ ...child("29"), relations: { ...empty, nodes: [relation] } }],
      pageInfo: { hasNextPage: !next, endCursor: next ? null : "next" },
    } } };
  }) as typeof linearGraphql;
  const graph = await getIssueWorkGraph(testConfig(), { id: "DRA-28" }, request);
  expect(seen).toEqual([{ id: "DRA-28", after: null }, { id: "DRA-28", after: "next" }]);
  expect(graph.children[0]!.blocks).toEqual(["31"]);
  expect(graph.children[1]!.blockedBy).toEqual(["29"]);
  expect(graph.children[1]!.state.name).toBe("Todo");
});

test("incomplete dependencies and reparenting fail closed", async () => {
  const node = child("29");
  const request = (async () => ({ issue: { id: "parent", identifier: "DRA-28", team: { states: { nodes: [] } }, children: { ...empty, nodes: [node] } } })) as typeof linearGraphql;
  node.parent.id = "other-parent";
  await expect(getIssueWorkGraph(testConfig(), { id: "parent" }, request)).rejects.toThrow("parent changed");
  node.parent.id = "parent";
  node.relations = { ...empty, pageInfo: { hasNextPage: true, endCursor: null } };
  await expect(getIssueWorkGraph(testConfig(), { id: "parent" }, request)).rejects.toThrow("dependency graph");
});
