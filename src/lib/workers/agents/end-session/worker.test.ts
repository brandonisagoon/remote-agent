import { afterEach, describe, expect, test } from "bun:test";

import type { AgentIssue, SessionRuntime } from "../../../../types/sessions/index.ts";
import { testConfig } from "../../../../test-support/config.ts";
import {
  buildAgentIssueDescription,
} from "../../../services/sessions/registry/index.ts";
import { createFakeBbClient, type FakeBbClient } from "../../../../test-support/bb.ts";
import { endSessionWorker } from "./worker.ts";

const originalFetch = globalThis.fetch;
const config = testConfig();

const states: AgentIssue["state"][] = [
  { id: "state-End", name: "End", type: "started" },
  { id: "state-Connected", name: "Connected", type: "started" },
  { id: "state-Ended", name: "Ended", type: "completed" },
  { id: "state-Deleted", name: "Deleted", type: "canceled" },
  { id: "state-Duplicate", name: "Duplicate", type: "canceled" },
];
const labelDefinitions = [
  ["Codex", "Harness"],
  ["Claude Code", "Harness"],
  ["Primary", "Role"],
  ["Delegate", "Role"],
  ["Accepts Linear Input", "Routing"],
  ["Does Not Accept Linear Input", "Routing"],
  ["Brandon's MacBook Air", "Machine"],
  ["Brandon's MacBook Pro", "Machine"],
  ["General", "Workflow"],
] as const;
const labels = labelDefinitions.map(([name, parent]) => ({
  id: `label-${name}`,
  name,
  parent: { id: `group-${parent}`, name: parent },
}));

afterEach(() => {
  globalThis.fetch = originalFetch;
});
function runtime(overrides: Partial<SessionRuntime> = {}): SessionRuntime {
  return {
    harnessSessionId: "primary-session",
    parentSessionId: null,
    worktreePath: "/tmp/end-status-cube-2801",
    branchName: "end-status-cube-2801",
    harness: "codex",
    machine: "macbook-air",
    role: "primary",
    bbThreadId: "thr_primary",
    ...overrides,
  };
}

function agentIssue(input: {
  id: string;
  identifier: string;
  state?: string;
  runtime?: SessionRuntime | null;
  labelNames?: string[];
}): AgentIssue {
  const state = states.find((entry) => entry.name === (input.state ?? "End"))!;
  const labelNames = input.labelNames ?? [
    input.runtime?.harness === "claude" ? "Claude Code" : "Codex",
    input.runtime?.role === "delegate" ? "Delegate" : "Primary",
    "Accepts Linear Input",
    "Brandon's MacBook Air",
    "General",
  ];
  return {
    id: input.id,
    identifier: input.identifier,
    title: input.identifier,
    description:
      input.runtime === null
        ? null
        : buildAgentIssueDescription(
            input.runtime ?? runtime(),
            {
              eventId: `event-${input.id}`,
              generation: 1,
              occurredAt: "2026-08-01T12:00:00.000Z",
              cubeIssueIdentifier: "CUBE-2801",
            },
            config,
          ),
    team: { id: "agent-team", key: "AGENT" },
    assignee: { id: config.agentUserId },
    state,
    labels: {
      nodes: labels.filter((label) => labelNames.includes(label.name)),
    },
  };
}

function commandClient(present = true): FakeBbClient {
  const client = createFakeBbClient();
  if (present) {
    for (const id of ["thr_primary", "thr_planner", "thr_unrelated"]) {
      client.putThread({
        id,
        projectId: config.bbProjectId,
        environmentId: "env-1",
        hostId: config.bbHostIds["macbook-air"] ?? null,
        providerId: "codex",
        title: null,
        status: "idle",
        parentThreadId: null,
        archivedAt: null,
      });
    }
  }
  return client;
}

function installLinear(issues: AgentIssue[]) {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const updates: Array<{
    id: string;
    input: { stateId?: string; labelIds?: string[]; description?: string };
  }> = [];

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: {
        id?: string;
        input?: { stateId?: string; labelIds?: string[]; description?: string };
      };
    };
    const { query, variables } = body;
    if (query.includes("AgentIssueById")) {
      return Response.json({ data: { issue: byId.get(variables.id!) ?? null } });
    }
    if (query.includes("AgentTeamCatalog")) {
      return Response.json({
        data: {
          teams: {
            nodes: [
              {
                id: "agent-team",
                states: { nodes: states },
                labels: { nodes: labels },
              },
            ],
          },
        },
      });
    }
    if (query.includes("MachineAgentIssues")) {
      return Response.json({
        data: { issues: { nodes: [...byId.values()] } },
      });
    }
    if (query.includes("UpdateAgentIssue")) {
      const issue = byId.get(variables.id!)!;
      const input = variables.input!;
      updates.push({ id: issue.id, input });
      const updated: AgentIssue = {
        ...issue,
        state: input.stateId
          ? states.find((state) => state.id === input.stateId)!
          : issue.state,
        labels: input.labelIds
          ? {
              nodes: labels.filter((label) => input.labelIds!.includes(label.id)),
            }
          : issue.labels,
      };
      byId.set(issue.id, updated);
      return Response.json({
        data: { issueUpdate: { success: true, issue: updated } },
      });
    }
    throw new Error(`Unexpected Linear operation: ${query.slice(0, 80)}`);
  }) as typeof fetch;

  return { byId, updates };
}

function event(target: AgentIssue) {
  return {
    type: "linear.issue.end-requested" as const,
    webhook: {
      type: "Issue" as const,
      action: "update" as const,
      webhookTimestamp: Date.now(),
      data: {
        id: target.id,
        identifier: target.identifier,
        state: target.state,
        team: { key: "AGENT" },
      },
      updatedFrom: { stateId: "previous-state" },
    },
  };
}

async function execute(target: AgentIssue, client: FakeBbClient) {
  return endSessionWorker.execute(event(target), {
    prisma: null as never,
    config,
    commandClient: {} as never,
    bbClient: client,
    runId: "run-1",
  });
}

describe("agents.end-session worker", () => {
  test("ends a lone primary before terminating its exact bb thread", async () => {
    const target = agentIssue({ id: "target", identifier: "AGENT-1" });
    const linear = installLinear([target]);
    const client = commandClient();

    const result = await execute(target, client);

    expect(result).toEqual({
      status: "delivered",
      detail: "ended 1 issue(s); terminated 1 bb thread(s)",
      targetAgentIssueIdentifier: "AGENT-1",
    });
    expect(linear.updates.map((update) => update.id)).toEqual(["target"]);
    expect(linear.updates[0]?.input).not.toHaveProperty("description");
    expect(linear.byId.get("target")?.state.name).toBe("Ended");
    expect(linear.byId.get("target")?.labels.nodes.map((label) => label.name))
      .toContain("Does Not Accept Linear Input");
    expect(client.archivedThreadIds).toEqual(["thr_primary"]);
  });

  test("ends subagent and orchestrated delegates before the primary", async () => {
    const target = agentIssue({ id: "target", identifier: "AGENT-1" });
    const subagent = agentIssue({
      id: "subagent",
      identifier: "AGENT-2",
      state: "Connected",
      runtime: runtime({
        harnessSessionId: "primary-session:subagent",
        role: "delegate",
        bbThreadId: "thr_primary",
      }),
    });
    const planner = agentIssue({
      id: "planner",
      identifier: "AGENT-3",
      state: "Connected",
      runtime: runtime({
        harnessSessionId: "planner-session",
        harness: "claude",
        role: "delegate",
        bbThreadId: "thr_planner",
      }),
    });
    const unrelated = agentIssue({
      id: "unrelated",
      identifier: "AGENT-4",
      state: "Connected",
      runtime: runtime({
        harnessSessionId: "unrelated-session",
        worktreePath: "/tmp/unrelated",
        bbThreadId: "thr_unrelated",
      }),
    });
    const linear = installLinear([target, subagent, planner, unrelated]);
    const client = commandClient();

    await execute(target, client);

    expect(linear.updates.map((update) => update.id)).toEqual([
      "subagent",
      "planner",
      "target",
    ]);
    expect(linear.byId.get("unrelated")?.state.name).toBe("Connected");
    expect(client.archivedThreadIds).toEqual(["thr_planner", "thr_primary"]);
  });

  test("ignores a session owned by another machine", async () => {
    const target = agentIssue({
      id: "target",
      identifier: "AGENT-1",
      labelNames: [
        "Codex",
        "Primary",
        "Accepts Linear Input",
        "Brandon's MacBook Pro",
        "General",
      ],
    });
    const linear = installLinear([target]);
    const client = commandClient();

    expect(await execute(target, client)).toMatchObject({
      status: "ignored",
      detail: "different_machine",
    });
    expect(linear.updates).toHaveLength(0);
    expect(client.archivedThreadIds).toHaveLength(0);
  });

  test("retries an already Ended target without rewriting it", async () => {
    const target = agentIssue({
      id: "target",
      identifier: "AGENT-1",
      state: "Ended",
    });
    const linear = installLinear([target]);
    const client = commandClient();

    expect(await execute(target, client)).toMatchObject({
      status: "delivered",
      detail: "ended 0 issue(s); terminated 1 bb thread(s)",
    });
    expect(linear.updates).toHaveLength(0);
    expect(client.archivedThreadIds).toEqual(["thr_primary"]);
  });

  test("delivers when the bb thread is already gone", async () => {
    const target = agentIssue({ id: "target", identifier: "AGENT-1" });
    const linear = installLinear([target]);

    expect(await execute(target, commandClient(false))).toMatchObject({
      status: "delivered",
      detail: "ended 1 issue(s); terminated 0 bb thread(s)",
    });
    expect(linear.byId.get("target")?.state.name).toBe("Ended");
  });

  test("rejects a stale target moved away from End", async () => {
    const target = agentIssue({
      id: "target",
      identifier: "AGENT-1",
      state: "Connected",
    });
    const linear = installLinear([target]);
    const client = commandClient();

    expect(await execute(target, client)).toMatchObject({
      status: "stale_target",
      detail: "issue_left_end_state",
    });
    expect(linear.updates).toHaveLength(0);
    expect(client.archivedThreadIds).toHaveLength(0);
  });

  test("marks an unparseable target Ended without attempting termination", async () => {
    const target = agentIssue({
      id: "target",
      identifier: "AGENT-1",
      runtime: null,
    });
    const linear = installLinear([target]);
    const client = commandClient();

    expect(await execute(target, client)).toMatchObject({
      status: "delivered",
      detail: "ended 1 issue(s); terminated 0 bb thread(s)",
    });
    expect(linear.byId.get("target")?.state.name).toBe("Ended");
    expect(client.archivedThreadIds).toHaveLength(0);
  });
});
