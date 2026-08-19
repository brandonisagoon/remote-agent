import { afterEach, describe, expect, test } from "bun:test";

import { testConfig } from "../../../../../test-support/config.ts";
import { getSourceIssueWithAgentIssues } from "./read.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("getSourceIssueWithAgentIssues", () => {
  test("requests and preserves Product label parent metadata", async () => {
    let query = "";
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      query = body.query;
      return Response.json({
        data: {
          issue: {
            id: "issue-id",
            identifier: "CUBE-2804",
            branchName: null,
            title: "Describe me",
            description: null,
            state: { name: "On Course" },
            labels: {
              nodes: [
                { name: "Bug", parent: { name: "Product" } },
                { name: "Backend", parent: null },
              ],
            },
            relations: { nodes: [] },
            inverseRelations: { nodes: [] },
          },
        },
      });
    }) as typeof fetch;

    const issue = await getSourceIssueWithAgentIssues(testConfig(), {
      id: "CUBE-2804",
    });

    expect(query).toContain("labels { nodes { name parent { name } } }");
    expect(issue?.labels.nodes).toEqual([
      { name: "Bug", parent: { name: "Product" } },
      { name: "Backend", parent: null },
    ]);
  });
});
