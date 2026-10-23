import { afterEach, describe, expect, test } from "bun:test";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

import { testConfig } from "../../../../test-support/config.ts";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../../../test-support/db.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { beginRuntimeSession } from "./runtime-registry.ts";
import {
  createPlanCaptureInterceptor,
  planFromPermissionRequest,
  splicePlanSection,
} from "./plan-capture.ts";

let database: TestDatabase | null = null;

afterEach(async () => {
  await database?.cleanup();
  database = null;
});

function exitPlanRequest(plan: string): RequestPermissionRequest {
  return {
    sessionId: "acp-session-1",
    toolCall: {
      toolCallId: "tool-1",
      kind: "switch_mode",
      rawInput: { plan },
    },
    options: [],
  };
}

function planCaptureConfig(thenState: string | null = "Planned"): ServerConfig {
  const base = testConfig();
  const workflows = {
    ...base.repository.workflows,
    "plan-capture": {
      id: "plan-capture",
      connectionId: null,
      on: "issue.state-changed" as const,
      when: null,
      skill: { skillset: "orchestrate", flags: [] },
      deliver: "start-session" as const,
      providerId: "claude" as const,
      model: null,
      plan: { captureToIssue: true as const, thenState },
    },
  };
  const repository = { ...base.repository, workflows };
  return {
    ...base,
    repository,
    repositories: { [repository.id]: repository },
  };
}

async function planSession(
  prisma: TestDatabase["prisma"],
  input: { workflowId?: string } = {},
) {
  return beginRuntimeSession(prisma, {
    sessionKey: `plan-${input.workflowId ?? "none"}`,
    agent: "claude",
    cwd: "/tmp/plan-repo",
    repositoryId: "test-repository",
    machineId: "macbook-air",
    ...(input.workflowId ? { workflowId: input.workflowId } : {}),
    resourceLinks: [{
      provider: "linear",
      connectionId: "linear-test",
      resourceType: "issue-identifier",
      externalId: "CUBE-42",
      relationship: "handles",
    }],
  });
}

describe("splicePlanSection", () => {
  test("appends below the original description", () => {
    expect(splicePlanSection("The original ask.", "Do the thing.")).toBe(
      "The original ask.\n\n## Implementation Plan\n\nDo the thing.\n",
    );
  });

  test("writes the section alone into an empty description", () => {
    expect(splicePlanSection(null, "Plan.")).toBe(
      "## Implementation Plan\n\nPlan.\n",
    );
  });

  test("replaces the existing section in place, preserving neighbors", () => {
    const description = [
      "Original ask.",
      "",
      "## Implementation Plan",
      "",
      "Old plan.",
      "",
      "## Notes",
      "",
      "Keep me.",
    ].join("\n");
    expect(splicePlanSection(description, "New plan.")).toBe(
      "Original ask.\n\n## Implementation Plan\n\nNew plan.\n\n## Notes\n\nKeep me.\n",
    );
  });

  test("re-splicing is idempotent", () => {
    const once = splicePlanSection("Ask.", "Plan.");
    expect(splicePlanSection(once, "Plan.")).toBe(once);
  });

  test("replaces a captured plan with its own headings without retaining old sections", () => {
    const first = splicePlanSection("Original ask.", "# First plan\n\n## Context\n\nOld context.\n\n## Steps\n\nOld steps.");
    expect(first).toContain("### First plan\n\n#### Context");
    const next = splicePlanSection(`${first}\n## Notes\n\nKeep me.`, "# Revised plan\n\n## Steps\n\nNew steps.");
    expect(next).toBe("Original ask.\n\n## Implementation Plan\n\n### Revised plan\n\n#### Steps\n\nNew steps.\n\n## Notes\n\nKeep me.\n");
    expect(splicePlanSection(next, "# Revised plan\n\n## Steps\n\nNew steps.")).toBe(next);
  });

  test("ignores heading-like text inside fenced code when finding section boundaries", () => {
    const original = "Original ask.\n\n```md\n## Implementation Plan\nexample only\n```";
    const plan = "## Steps\n\n~~~md\n## Example\n~~~\n\nDone.";
    const first = splicePlanSection(original, plan);
    expect(first).toContain("### Steps\n\n~~~md\n## Example\n~~~");
    expect(splicePlanSection(`${first}\n## Notes\n\nKeep me.`, "Revised.")).toBe(`${original}\n\n## Implementation Plan\n\nRevised.\n\n## Notes\n\nKeep me.\n`);
  });
});

describe("planFromPermissionRequest", () => {
  test("extracts the plan from an exit-plan-mode request", () => {
    expect(planFromPermissionRequest(exitPlanRequest("The plan."))).toBe("The plan.");
  });

  test("ignores non-mode-switch permissions and missing plans", () => {
    const write: RequestPermissionRequest = {
      sessionId: "acp-session-1",
      toolCall: { toolCallId: "tool-2", kind: "edit", rawInput: { path: "a" } },
      options: [],
    };
    expect(planFromPermissionRequest(write)).toBeNull();
    const modeOnly: RequestPermissionRequest = {
      sessionId: "acp-session-1",
      toolCall: { toolCallId: "tool-3", kind: "switch_mode", rawInput: {} },
      options: [],
    };
    expect(planFromPermissionRequest(modeOnly)).toBeNull();
  });
});

describe("plan capture interceptor", () => {
  test("writes the plan, then transitions the issue, and never decides", async () => {
    database = await createTestDatabase();
    const session = await planSession(database.prisma, { workflowId: "plan-capture" });
    const updates: Array<Record<string, string>> = [];
    const interceptor = createPlanCaptureInterceptor(
      { prisma: database.prisma, config: planCaptureConfig() },
      {
        getIssue: async (_config, query) => ({
          id: `uuid-${query.id}`,
          description: "Original ask.",
          team: { states: { nodes: [{ id: "state-planned", name: "Planned" }] } },
        }),
        updateIssue: async (_config, _query, input) => {
          updates.push(input as Record<string, string>);
        },
      },
    );
    const decision = await interceptor(
      { sessionId: session.id, raw: exitPlanRequest("Step one.") },
      { signal: new AbortController().signal },
    );
    expect(decision).toBeUndefined();
    expect(updates).toEqual([
      { description: "Original ask.\n\n## Implementation Plan\n\nStep one.\n" },
      { stateId: "state-planned" },
    ]);
  });

  test("plan reads and writes use the linked connection instead of the server default", async () => {
    database = await createTestDatabase();
    const session = await planSession(database.prisma, { workflowId: "plan-capture" });
    const config = planCaptureConfig();
    config.connections = { ...config.connections, "other-linear": { ...config.connections["linear-test"]!, id: "other-linear", apiKey: "other-workspace-key" } };
    await database.prisma.runtimeSessionResourceLink.updateMany({ where: { runtimeSessionId: session.id, relationship: "handles" }, data: { connectionId: "other-linear" } });
    const observed: string[] = [];
    const interceptor = createPlanCaptureInterceptor({ prisma: database.prisma, config }, {
      getIssue: async (scoped) => {
        observed.push(scoped.activeConnectionId);
        expect(scoped.linearApiKey).toBe("other-workspace-key");
        return { id: "other-issue", description: "Keep original.", team: { states: { nodes: [{ id: "planned", name: "Planned" }] } } };
      },
      updateIssue: async (scoped) => { observed.push(scoped.activeConnectionId); expect(scoped.linearApiKey).toBe("other-workspace-key"); },
    });
    await interceptor({ sessionId: session.id, raw: exitPlanRequest("Scoped plan.") }, { signal: new AbortController().signal });
    expect(observed).toEqual(["other-linear", "other-linear", "other-linear"]);
    expect(config.activeConnectionId).toBe("linear-test");
  });

  test("does nothing for sessions without a plan-capture workflow", async () => {
    database = await createTestDatabase();
    const session = await planSession(database.prisma);
    let touched = 0;
    const interceptor = createPlanCaptureInterceptor(
      { prisma: database.prisma, config: planCaptureConfig() },
      {
        getIssue: async () => {
          touched += 1;
          return null;
        },
        updateIssue: async () => {
          touched += 1;
        },
      },
    );
    const decision = await interceptor(
      { sessionId: session.id, raw: exitPlanRequest("Plan.") },
      { signal: new AbortController().signal },
    );
    expect(decision).toBeUndefined();
    expect(touched).toBe(0);
  });

  test("a failing Linear write still defers to the runtime policy", async () => {
    database = await createTestDatabase();
    const session = await planSession(database.prisma, { workflowId: "plan-capture" });
    const interceptor = createPlanCaptureInterceptor(
      { prisma: database.prisma, config: planCaptureConfig() },
      {
        getIssue: async () => ({
          id: "uuid-CUBE-42",
          description: null,
          team: { states: { nodes: [] } },
        }),
        updateIssue: async () => {
          throw new Error("Linear is down");
        },
      },
    );
    const decision = await interceptor(
      { sessionId: session.id, raw: exitPlanRequest("Plan.") },
      { signal: new AbortController().signal },
    );
    expect(decision).toBeUndefined();
  });
});
