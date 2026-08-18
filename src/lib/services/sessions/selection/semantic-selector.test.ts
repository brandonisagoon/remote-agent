import { describe, expect, test } from "bun:test";
import path from "node:path";

import { testConfig } from "../../../../test-support/config.ts";
import {
  RouteActionSchema,
  RouteReasonSchema,
  type RouteAction,
  type ReplyTarget,
  type RouteCandidate,
  type RoutingInput,
} from "../../../../types/sessions/index.ts";
import {
  outputSchema,
  selectSessionWithCodex,
} from "./semantic-selector.ts";

const FAKE_CODEX = path.join(
  import.meta.dir,
  "../../../../test-support/fake-codex.ts",
);
const REPLY_TARGETS: ReplyTarget[] = [
  {
    commentId: "comment-cube-2829-reply",
    kind: "source",
    authorName: "Brandon",
    excerpt: "@agent yes always",
  },
  {
    commentId: "comment-cube-2829-root",
    kind: "thread_root",
    authorName: "Agent",
    excerpt: "Claude is waiting for a reply decision.",
  },
];
const SINGLE_CANDIDATE_ACTION_CASES: Array<[string, RouteAction[]]> = [
  ["@agent please update the plan to cover pagination", ["plan_update"]],
  ["@agent implement the retry fix", ["code_change"]],
  ["FYI: deploy finished", []],
];

function candidate(
  identifier: string,
  pane: string,
): RouteCandidate {
  return {
    agentIssueId: `issue-${identifier}`,
    agentIssueIdentifier: identifier,
    status: "Connected",
    assigneeId: "11111111-2222-3333-4444-555555555555",
    labels: [
      "Codex",
      "Primary",
      "Accepts Linear Input",
      "Brandon's MacBook Air",
    ],
    runtime: {
      harnessSessionId: `session-${identifier}`,
      parentSessionId: null,
      worktreePath: `/tmp/${identifier.toLowerCase()}`,
      branchName: `work-${identifier.toLowerCase()}`,
      harness: "codex",
      machine: "macbook-air",
      role: "primary",
      bbThreadId: `bb-${identifier.toLowerCase()}`,
    },
  };
}

function routingInput(
  candidates: RouteCandidate[],
  overrides: Partial<Pick<RoutingInput, "comment" | "replyTargets">> = {},
): RoutingInput {
  return {
    cubeIssueIdentifier: "CUBE-2829",
    cubeIssue: {
      identifier: "CUBE-2829",
      title: "Open Worktree From Linear Deep Link Comment",
      description: "Regression fixture for the AGENT-130 delivery failure.",
      status: "On Course",
      labels: [],
    },
    comment: "@agent yes always",
    workerContext: {
      key: "product.agent-mention",
      routingHint: "Prefer the only eligible Primary.",
    },
    candidates,
    replyTargets: REPLY_TARGETS,
    ...overrides,
  };
}

describe("Codex semantic selector", () => {
  test("generates a supported schema from the zod routing vocabularies", () => {
    const candidates = [candidate("AGENT-130", "%130")];
    const schema = outputSchema(candidates, REPLY_TARGETS);
    const keywords = collectSchemaKeywords(schema);

    expect([...keywords].sort()).toEqual([
      "additionalProperties",
      "enum",
      "items",
      "maximum",
      "minimum",
      "properties",
      "required",
      "type",
    ]);
    expect(JSON.stringify(schema)).not.toContain("uniqueItems");
    expect(schema.properties.reasonCode.enum).toEqual(
      RouteReasonSchema.options,
    );
    expect(schema.properties.expectedActions.items.enum).toEqual(
      RouteActionSchema.options,
    );
    expect(schema.properties.targetAgentIssueIdentifier.enum).toContain(
      "AGENT-130",
    );
    expect(schema.properties.replyToCommentId.enum).toContain(
      "comment-cube-2829-root",
    );
  });

  describe("single-candidate routing", () => {
    const onlyCandidate = [candidate("AGENT-130", "%130")];
    const fakeConfig = testConfig({ codexExecutable: FAKE_CODEX });

    test("keeps target selection deterministic while classifying a reply", async () => {
      await expect(
        selectSessionWithCodex(fakeConfig, routingInput(onlyCandidate)),
      ).resolves.toEqual({
        targetAgentIssueIdentifier: "AGENT-130",
        reasonCode: "only_eligible_candidate",
        confidence: 1,
        expectedActions: ["reply"],
        replyToCommentId: "comment-cube-2829-reply",
      });
    });

    test.each(SINGLE_CANDIDATE_ACTION_CASES)(
      "classifies %s",
      async (comment, expectedActions) => {
        await expect(
          selectSessionWithCodex(
            fakeConfig,
            routingInput(onlyCandidate, { comment }),
          ),
        ).resolves.toEqual({
          targetAgentIssueIdentifier: "AGENT-130",
          reasonCode: "only_eligible_candidate",
          confidence: 1,
          expectedActions,
          replyToCommentId: null,
        });
      },
    );

    test("skips classification when no reply targets exist", async () => {
      await expect(
        selectSessionWithCodex(
          testConfig({ codexExecutable: "/nonexistent/codex" }),
          routingInput(onlyCandidate, { replyTargets: undefined }),
        ),
      ).resolves.toEqual({
        targetAgentIssueIdentifier: "AGENT-130",
        reasonCode: "only_eligible_candidate",
        confidence: 1,
        expectedActions: [],
        replyToCommentId: null,
      });
    });

    test.each([
      ["missing executable", "/nonexistent/codex", undefined],
      ["invalid router output", FAKE_CODEX, "fake-invalid-schema"],
    ])(
      "falls back to reply for %s",
      async (_name, codexExecutable, routerModel) => {
        await expect(
          selectSessionWithCodex(
            testConfig({ codexExecutable, routerModel }),
            routingInput(onlyCandidate),
          ),
        ).resolves.toEqual({
          targetAgentIssueIdentifier: "AGENT-130",
          reasonCode: "only_eligible_candidate",
          confidence: 1,
          expectedActions: ["reply"],
          replyToCommentId: "comment-cube-2829-reply",
        });
      },
    );
  });

  test("replays multi-candidate selection through the real routing MCP", async () => {
    const decision = await selectSessionWithCodex(
      testConfig({ codexExecutable: FAKE_CODEX }),
      routingInput([
        candidate("AGENT-130", "%130"),
        candidate("AGENT-131", "%131"),
      ]),
    );

    expect(decision).toEqual({
      targetAgentIssueIdentifier: "AGENT-130",
      reasonCode: "primary_session",
      confidence: 1,
      expectedActions: ["reply"],
      replyToCommentId: "comment-cube-2829-reply",
    });
  });

  test("keeps the actionable tail of multi-candidate router failures", async () => {
    let thrown: unknown;
    try {
      await selectSessionWithCodex(
        testConfig({
          codexExecutable: FAKE_CODEX,
          routerModel: "fake-invalid-schema",
        }),
        routingInput([
          candidate("AGENT-130", "%130"),
          candidate("AGENT-131", "%131"),
        ]),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("invalid_json_schema");
    expect((thrown as Error).message).toContain(
      "'uniqueItems' is not permitted",
    );
  });
});

function collectSchemaKeywords(value: unknown): Set<string> {
  const keywords = new Set<string>();

  function visit(schema: unknown) {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
    for (const [key, child] of Object.entries(schema)) {
      keywords.add(key);
      if (key === "properties" && child && typeof child === "object") {
        for (const property of Object.values(child)) visit(property);
      } else if (key === "items") {
        visit(child);
      }
    }
  }

  visit(value);
  return keywords;
}
