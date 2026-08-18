import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createApp } from "../../app.ts";
import { testConfig } from "../../test-support/config.ts";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../test-support/db.ts";
import {
  parseAgentIssueSourceIdentifier,
  reconcileMachineSnapshot,
} from "../../lib/services/sessions/index.ts";
import type { BbClient, CommandClient } from "../../types/runtime/index.ts";

const originalFetch = globalThis.fetch;
let database: TestDatabase | null = null;

const states = [
  "Registered",
  "Connected",
  "Disconnected",
  "Ended",
  "Error",
  "Duplicate",
].map((name) => ({ id: `state-${name}`, name, type: "started" }));
const labelDefinitions = [
  ["Codex", "Harness"],
  ["Claude Code", "Harness"],
  ["Primary", "Role"],
  ["Delegate", "Role"],
  ["Viewer", "Role"],
  ["Unassigned", "Role"],
  ["Accepts Linear Input", "Routing"],
  ["Does Not Accept Linear Input", "Routing"],
  ["Brandon's MacBook Air", "Machine"],
  ["Brandon's MacBook Pro", "Machine"],
  ["General", "Workflow"],
  ["describe-linear-issue", "Workflow"],
  ["plan-linear", "Workflow"],
  ["orchestrate-plan-linear", "Workflow"],
  ["reflect-linear", "Workflow"],
] as const;
const labels = labelDefinitions.map(([name, parent]) => ({
  id: `label-${name}`,
  name,
  parent: { id: `group-${parent}`, name: parent },
}));

function installLinearSessionFixture() {
  const issues = new Map<string, Record<string, any>>();
  const related = new Set<string>();
  let sequence = 0;

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, any>;
    };
    const { query, variables } = body;

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
    if (query.includes("CubeIssue")) {
      return Response.json({
        data: { issue: { id: `cube-${variables.id}` } },
      });
    }
    if (query.includes("SearchAgentIssues")) {
      return Response.json({ data: { searchIssues: { nodes: [] } } });
    }
    if (query.includes("MachineAgentIssues")) {
      return Response.json({
        data: { issues: { nodes: [...issues.values()] } },
      });
    }
    if (query.includes("CreateAgentIssue")) {
      sequence += 1;
      const input = variables.input;
      const issue = {
        id: `linear-session-${sequence}`,
        identifier: `AGENT-${sequence}`,
        title: input.title,
        description: input.description,
        team: { id: "agent-team", key: "AGENT" },
        assignee: { id: input.assigneeId },
        state: states.find((state) => state.id === input.stateId),
        labels: {
          nodes: labels.filter((label) => input.labelIds.includes(label.id)),
        },
      };
      issues.set(issue.id, issue);
      return Response.json({
        data: { issueCreate: { success: true, issue } },
      });
    }
    if (query.includes("AgentIssueById")) {
      return Response.json({ data: { issue: issues.get(variables.id) } });
    }
    if (query.includes("UpdateAgentIssue")) {
      const issue = issues.get(variables.id)!;
      const input = variables.input;
      Object.assign(issue, {
        ...(input.title ? { title: input.title } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.stateId
          ? { state: states.find((state) => state.id === input.stateId) }
          : {}),
        ...(input.labelIds
          ? {
              labels: {
                nodes: labels.filter((label) =>
                  input.labelIds.includes(label.id),
                ),
              },
            }
          : {}),
      });
      return Response.json({
        data: { issueUpdate: { success: true, issue } },
      });
    }
    if (query.includes("AgentIssueRelations")) {
      return Response.json({
        data: {
          issue: {
            relations: {
              nodes: related.has(variables.id)
                ? [
                    {
                      id: `relation-${variables.id}`,
                      type: "related",
                      cubeIssue: { identifier: "CUBE-2999" },
                    },
                  ]
                : [],
            },
          },
        },
      });
    }
    if (query.includes("RelateAgentIssue")) {
      related.add(variables.input.issueId);
      return Response.json({
        data: {
          issueRelationCreate: {
            success: true,
            issueRelation: { id: `relation-${variables.input.issueId}` },
          },
        },
      });
    }
    if (query.includes("DeleteAgentIssueRelation")) {
      related.delete(String(variables.id).replace(/^relation-/, ""));
      return Response.json({
        data: { issueRelationDelete: { success: true } },
      });
    }
    throw new Error(`Unexpected Linear operation: ${query.slice(0, 80)}`);
  }) as typeof fetch;

  return {
    issues,
    issueForSession(harnessSessionId: string) {
      return [...issues.values()].find((issue) =>
        issue.description.includes(
          `| Harness session ID | \`${harnessSessionId}\` |`,
        ),
      );
    },
  };
}

function recordingCommandClient(): CommandClient & { kills: string[] } {
  return {
    kills: [],
    async run() {
      return { ok: true, stdout: "", stderr: "" };
    },
  };
}

function recordingBbClient(
  present = true,
): BbClient & { archivedThreadIds: string[] } {
  const archivedThreadIds: string[] = [];
  return {
    archivedThreadIds,
    async getThread(id) {
      if (!present) return null;
      return {
        id,
        projectId: "proj_test",
        environmentId: "env_test",
        hostId: "host_air",
        providerId: "codex",
        title: null,
        status: "idle",
        parentThreadId: null,
        archivedAt: null,
      };
    },
    async openThread() {
      return 1;
    },
    async getThreadOutput() {
      return null;
    },
    async getThreadExecutionOptions() {
      return null;
    },
    async getEnvironment() {
      return null;
    },
    async listThreads() {
      return [];
    },
    async listProviders() {
      return [];
    },
    async listModels() {
      return [];
    },
    async listEvents() {
      return [];
    },
    async listInteractions() {
      return [];
    },
    async resolveInteraction() {},
    async sendMessage() {},
    async spawnThread() {
      throw new Error("not used");
    },
    async updateThreadExecutionOptions() {},
    async stopThread() {},
    async archiveThread(id) {
      archivedThreadIds.push(id);
    },
    async listMachines() {
      return [];
    },
    async *streamEvents() {},
  };
}

beforeEach(async () => {
  database = await createTestDatabase();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await database?.cleanup();
  database = null;
});

describe("POST /api/session-events", () => {
  test("concurrent session starts create one Linear registry issue", async () => {
    let createCalls = 0;
    let issue: Record<string, any> = {};
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, any>;
      };
      const { query, variables } = body;

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
      if (query.includes("CubeIssue")) {
        return Response.json({ data: { issue: { id: "cube-issue" } } });
      }
      if (query.includes("SearchAgentIssues")) {
        return Response.json({ data: { searchIssues: { nodes: [] } } });
      }
      if (query.includes("CreateAgentIssue")) {
        createCalls += 1;
        await Bun.sleep(5);
        const input = variables.input;
        issue = {
          id: "linear-session",
          identifier: "AGENT-1",
          title: input.title,
          description: input.description,
          team: { id: "agent-team", key: "AGENT" },
          assignee: { id: input.assigneeId },
          state: states.find((state) => state.id === input.stateId),
          labels: {
            nodes: labels.filter((label) => input.labelIds.includes(label.id)),
          },
        };
        return Response.json({
          data: { issueCreate: { success: true, issue } },
        });
      }
      if (query.includes("AgentIssueById")) {
        return Response.json({ data: { issue } });
      }
      if (query.includes("UpdateAgentIssue")) {
        const input = variables.input;
        issue = {
          ...issue,
          ...(input.title ? { title: input.title } : {}),
          ...(input.description ? { description: input.description } : {}),
          ...(input.stateId
            ? { state: states.find((state) => state.id === input.stateId) }
            : {}),
          ...(input.labelIds
            ? {
                labels: {
                  nodes: labels.filter((label) =>
                    input.labelIds.includes(label.id),
                  ),
                },
              }
            : {}),
        };
        return Response.json({
          data: { issueUpdate: { success: true, issue } },
        });
      }
      if (query.includes("RelateAgentIssue")) {
        return Response.json({
          data: {
            issueRelationCreate: {
              success: true,
              issueRelation: { id: "relation" },
            },
          },
        });
      }
      throw new Error(`Unexpected Linear operation: ${query.slice(0, 80)}`);
    }) as typeof fetch;

    const app = createApp({
      config: testConfig(),
      bbClient: recordingBbClient(),
      prisma: database!.prisma,
    });
    const event = (eventId: string, generation: number) => ({
      eventId,
      occurredAt: `2026-07-31T12:00:0${generation}.000Z`,
      generation,
      type: "session.started",
      runtime: {
        harnessSessionId: "claude-session",
        parentSessionId: null,
        worktreePath: "/tmp/example-cube-2750",
        branchName: "example-cube-2750",
        harness: "claude",
        machine: "macbook-air",
        role: "primary",
        bbThreadId: "test-session",
      },
    });
    const request = (body: object) =>
      app.request("/api/session-events", {
        method: "POST",
        headers: {
          authorization: "Bearer test-api-key",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

    const responses = await Promise.all([
      request(event("event-1", 1)),
      request(event("event-2", 2)),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(createCalls).toBe(1);
    expect(
      await database!.prisma.agentIssueRecord.count({
        where: { harnessSessionId: "claude-session" },
      }),
    ).toBe(1);

    const workflowResponse = await request({
      ...event("event-workflow", 3),
      type: "workflow.started",
      workflow: "plan-linear",
    });
    expect(workflowResponse.status).toBe(200);
    expect(issue?.title).toContain("CUBE-2750");
  });

  test("a main-worktree session attaches before its workflow starts", async () => {
    let issue: Record<string, any> = {};
    let relationAttached = false;
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, any>;
      };
      const { query, variables } = body;

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
      if (query.includes("CubeIssue")) {
        return Response.json({ data: { issue: { id: "cube-issue" } } });
      }
      if (query.includes("SearchAgentIssues")) {
        return Response.json({ data: { searchIssues: { nodes: [] } } });
      }
      if (query.includes("CreateAgentIssue")) {
        const input = variables.input;
        issue = {
          id: "linear-session",
          identifier: "AGENT-1",
          title: input.title,
          description: input.description,
          team: { id: "agent-team", key: "AGENT" },
          assignee: { id: input.assigneeId },
          state: states.find((state) => state.id === input.stateId),
          labels: {
            nodes: labels.filter((label) => input.labelIds.includes(label.id)),
          },
        };
        return Response.json({
          data: { issueCreate: { success: true, issue } },
        });
      }
      if (query.includes("AgentIssueById")) {
        return Response.json({ data: { issue } });
      }
      if (query.includes("UpdateAgentIssue")) {
        const input = variables.input;
        issue = {
          ...issue,
          ...(input.title ? { title: input.title } : {}),
          ...(input.description ? { description: input.description } : {}),
          ...(input.stateId
            ? { state: states.find((state) => state.id === input.stateId) }
            : {}),
          ...(input.labelIds
            ? {
                labels: {
                  nodes: labels.filter((label) =>
                    input.labelIds.includes(label.id),
                  ),
                },
              }
            : {}),
        };
        return Response.json({
          data: { issueUpdate: { success: true, issue } },
        });
      }
      if (query.includes("AgentIssueRelations")) {
        return Response.json({
          data: {
            issue: {
              relations: {
                nodes: relationAttached
                  ? [
                      {
                        id: "relation",
                        type: "related",
                        cubeIssue: { identifier: "CUBE-2999" },
                      },
                    ]
                  : [],
              },
            },
          },
        });
      }
      if (query.includes("RelateAgentIssue")) {
        relationAttached = true;
        return Response.json({
          data: {
            issueRelationCreate: {
              success: true,
              issueRelation: { id: "relation" },
            },
          },
        });
      }
      if (query.includes("DeleteAgentIssueRelation")) {
        relationAttached = false;
        return Response.json({
          data: { issueRelationDelete: { success: true } },
        });
      }
      throw new Error(`Unexpected Linear operation: ${query.slice(0, 80)}`);
    }) as typeof fetch;

    const commandClient = recordingCommandClient();
    const bbClient = recordingBbClient();
    const app = createApp({
      config: testConfig(),
      commandClient,
      bbClient,
      prisma: database!.prisma,
    });
    const runtime = {
      harnessSessionId: "claude-main-session",
      parentSessionId: null,
      worktreePath: "/tmp/main",
      branchName: "main",
      harness: "claude",
      machine: "macbook-air",
      role: "primary",
      lifecycle: "persistent",
      cubeIssueIdentifier: "CUBE-2999",
      bbThreadId: "main-session",
    };
    const request = (body: object) =>
      app.request("/api/session-events", {
        method: "POST",
        headers: {
          authorization: "Bearer test-api-key",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

    const started = await request({
      eventId: "event-started",
      occurredAt: "2026-08-03T12:00:00.000Z",
      generation: 1,
      type: "session.started",
      runtime,
    });
    expect(started.status).toBe(200);
    expect(issue?.state.name).toBe("Connected");
    expect(issue?.title).toContain("CUBE-2999");
    expect(relationAttached).toBeTrue();
    expect(bbClient.archivedThreadIds).toHaveLength(0);

    const workflowStarted = await request({
      eventId: "event-workflow-started",
      occurredAt: "2026-08-03T12:00:01.000Z",
      generation: 2,
      type: "workflow.started",
      workflow: "describe-linear-issue",
      cubeIssueIdentifier: "CUBE-2999",
      runtime,
    });
    expect(workflowStarted.status).toBe(200);
    expect(issue?.state.name).toBe("Connected");
    expect(issue?.title).toContain("CUBE-2999");
    expect(issue?.labels.nodes.map((label: any) => label.name)).toContain(
      "describe-linear-issue",
    );
    expect(issue?.labels.nodes.map((label: any) => label.name)).toContain(
      "Accepts Linear Input",
    );
    expect(parseAgentIssueSourceIdentifier(issue?.description ?? null)).toBe(
      "CUBE-2999",
    );
    expect(relationAttached).toBeTrue();

    const workflowEnded = await request({
      eventId: "event-workflow-ended",
      occurredAt: "2026-08-03T12:00:02.000Z",
      generation: 3,
      type: "workflow.ended",
      workflow: "describe-linear-issue",
      runtime,
    });
    expect(workflowEnded.status).toBe(200);
    expect(issue?.state.name).toBe("Connected");
    expect(issue?.title).toContain("CUBE-2999");
    expect(issue?.labels.nodes.map((label: any) => label.name)).toContain(
      "General",
    );
    expect(parseAgentIssueSourceIdentifier(issue?.description ?? null)).toBe(
      "CUBE-2999",
    );
    expect(relationAttached).toBeTrue();

    const invalid = await request({
      eventId: "event-invalid",
      occurredAt: "2026-08-03T12:00:03.000Z",
      generation: 4,
      type: "workflow.started",
      workflow: "describe-linear-issue",
      cubeIssueIdentifier: "not-an-id",
      runtime,
    });
    expect(invalid.status).toBe(400);
  });

  test("ends and then asynchronously kills a one-shot root workflow", async () => {
    let issue: Record<string, any> = {};
    let relationAttached = false;
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, any>;
      };
      const { query, variables } = body;

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
      if (query.includes("CubeIssue")) {
        return Response.json({ data: { issue: { id: "cube-issue" } } });
      }
      if (query.includes("SearchAgentIssues")) {
        return Response.json({ data: { searchIssues: { nodes: [] } } });
      }
      if (query.includes("MachineAgentIssues")) {
        return Response.json({
          data: { issues: { nodes: issue.id ? [issue] : [] } },
        });
      }
      if (query.includes("CreateAgentIssue")) {
        const input = variables.input;
        issue = {
          id: "one-shot-session",
          identifier: "AGENT-2",
          title: input.title,
          description: input.description,
          team: { id: "agent-team", key: "AGENT" },
          assignee: { id: input.assigneeId },
          state: states.find((state) => state.id === input.stateId),
          labels: {
            nodes: labels.filter((label) => input.labelIds.includes(label.id)),
          },
        };
        return Response.json({
          data: { issueCreate: { success: true, issue } },
        });
      }
      if (query.includes("AgentIssueById")) {
        return Response.json({ data: { issue } });
      }
      if (query.includes("UpdateAgentIssue")) {
        const input = variables.input;
        issue = {
          ...issue,
          ...(input.title ? { title: input.title } : {}),
          ...(input.description ? { description: input.description } : {}),
          ...(input.stateId
            ? { state: states.find((state) => state.id === input.stateId) }
            : {}),
          ...(input.labelIds
            ? {
                labels: {
                  nodes: labels.filter((label) =>
                    input.labelIds.includes(label.id),
                  ),
                },
              }
            : {}),
        };
        return Response.json({
          data: { issueUpdate: { success: true, issue } },
        });
      }
      if (query.includes("AgentIssueRelations")) {
        return Response.json({
          data: {
            issue: {
              relations: {
                nodes: relationAttached
                  ? [
                      {
                        id: "relation",
                        type: "related",
                        cubeIssue: { identifier: "CUBE-2999" },
                      },
                    ]
                  : [],
              },
            },
          },
        });
      }
      if (query.includes("RelateAgentIssue")) {
        relationAttached = true;
        return Response.json({
          data: {
            issueRelationCreate: {
              success: true,
              issueRelation: { id: "relation" },
            },
          },
        });
      }
      if (query.includes("DeleteAgentIssueRelation")) {
        relationAttached = false;
        return Response.json({
          data: { issueRelationDelete: { success: true } },
        });
      }
      throw new Error(`Unexpected Linear operation: ${query.slice(0, 80)}`);
    }) as typeof fetch;

    const commandClient = recordingCommandClient();
    const bbClient = recordingBbClient();
    const app = createApp({
      config: testConfig(),
      commandClient,
      bbClient,
      prisma: database!.prisma,
    });
    const runtime = {
      harnessSessionId: "one-shot-main-session",
      parentSessionId: null,
      worktreePath: "/tmp/main",
      branchName: "main",
      harness: "codex",
      machine: "macbook-air",
      role: "primary",
      lifecycle: "one-shot",
      bbThreadId: "one-shot-thread",
    };
    const request = (body: object) =>
      app.request("/api/session-events", {
        method: "POST",
        headers: {
          authorization: "Bearer test-api-key",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

    expect(
      (
        await request({
          eventId: "one-shot-session-started",
          occurredAt: "2026-08-03T13:00:00.000Z",
          generation: 10,
          type: "session.started",
          runtime,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request({
          eventId: "one-shot-workflow-started",
          occurredAt: "2026-08-03T13:00:01.000Z",
          generation: 11,
          type: "workflow.started",
          workflow: "describe-linear-issue",
          cubeIssueIdentifier: "CUBE-2999",
          runtime,
        })
      ).status,
    ).toBe(200);

    const endedEvent = {
      eventId: "one-shot-workflow-ended",
      occurredAt: "2026-08-03T13:00:02.000Z",
      generation: 12,
      type: "workflow.ended",
      workflow: "describe-linear-issue",
      runtime,
    };
    expect((await request(endedEvent)).status).toBe(200);
    expect(issue.state.name).toBe("Ended");
    expect(issue.labels.nodes.map((label: any) => label.name)).toContain(
      "Does Not Accept Linear Input",
    );
    expect(relationAttached).toBeFalse();
    expect(bbClient.archivedThreadIds).toHaveLength(0);

    await Bun.sleep(400);
    expect(bbClient.archivedThreadIds).toEqual(["one-shot-thread"]);

    expect((await request(endedEvent)).status).toBe(200);
    await Bun.sleep(400);
    expect(issue.state.name).toBe("Ended");
    expect(bbClient.archivedThreadIds).toEqual([
      "one-shot-thread",
      "one-shot-thread",
    ]);
  });

  test("tears down one-shot session.ended but not subagent.ended", async () => {
    installLinearSessionFixture();
    const commandClient = recordingCommandClient();
    const bbClient = recordingBbClient();
    const app = createApp({
      config: testConfig(),
      commandClient,
      bbClient,
      prisma: database!.prisma,
    });
    const request = (body: object) =>
      app.request("/api/session-events", {
        method: "POST",
        headers: {
          authorization: "Bearer test-api-key",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const rootRuntime = {
      harnessSessionId: "clean-one-shot-session",
      parentSessionId: null,
      worktreePath: "/tmp/main",
      branchName: "main",
      harness: "claude",
      machine: "macbook-air",
      role: "primary",
      lifecycle: "one-shot",
      cubeIssueIdentifier: "CUBE-2999",
      bbThreadId: "clean-one-shot-thread",
    };

    expect(
      (
        await request({
          eventId: "clean-one-shot-started",
          occurredAt: "2026-08-03T15:00:00.000Z",
          generation: 30,
          type: "session.started",
          runtime: rootRuntime,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request({
          eventId: "clean-one-shot-ended",
          occurredAt: "2026-08-03T15:00:01.000Z",
          generation: 31,
          type: "session.ended",
          runtime: rootRuntime,
        })
      ).status,
    ).toBe(200);
    await Bun.sleep(400);
    expect(bbClient.archivedThreadIds).toEqual(["clean-one-shot-thread"]);

    expect(
      (
        await request({
          eventId: "clean-one-shot-subagent-ended",
          occurredAt: "2026-08-03T15:00:02.000Z",
          generation: 32,
          type: "subagent.ended",
          runtime: {
            ...rootRuntime,
            harnessSessionId: "clean-one-shot-session:delegate",
            parentSessionId: "clean-one-shot-session",
            role: "delegate",
          },
        })
      ).status,
    ).toBe(200);
    await Bun.sleep(400);
    expect(bbClient.archivedThreadIds).toEqual(["clean-one-shot-thread"]);
  });

  test("reconciliation ends dead one-shot sessions and disconnects persistent ones", async () => {
    const fixture = installLinearSessionFixture();
    const commandClient = recordingCommandClient();
    const bbClient = recordingBbClient();
    const app = createApp({
      config: testConfig(),
      commandClient,
      bbClient,
      prisma: database!.prisma,
    });
    const request = (body: object) =>
      app.request("/api/session-events", {
        method: "POST",
        headers: {
          authorization: "Bearer test-api-key",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const runtime = (lifecycle: "one-shot" | "persistent", pane: string) => ({
      harnessSessionId: `${lifecycle}-reconcile-session`,
      parentSessionId: null,
      worktreePath: "/tmp/main",
      branchName: "main",
      harness: "codex",
      machine: "macbook-air",
      role: "primary",
      lifecycle,
      cubeIssueIdentifier: "CUBE-2999",
      bbThreadId: `${lifecycle}-reconcile-thread`,
    });

    for (const [generation, sessionRuntime] of [
      [40, runtime("one-shot", "%13")],
      [41, runtime("persistent", "%14")],
    ] as const) {
      expect(
        (
          await request({
            eventId: `reconcile-started-${generation}`,
            occurredAt: "2026-08-03T16:00:00.000Z",
            generation,
            type: "session.started",
            runtime: sessionRuntime,
          })
        ).status,
      ).toBe(200);
    }

    expect(
      await reconcileMachineSnapshot(testConfig(), "macbook-air", []),
    ).toEqual({
      connected: 0,
      disconnected: 1,
      ended: 1,
    });
    expect(
      fixture.issueForSession("one-shot-reconcile-session")?.state.name,
    ).toBe("Ended");
    expect(
      fixture.issueForSession("persistent-reconcile-session")?.state.name,
    ).toBe("Disconnected");
    expect(bbClient.archivedThreadIds).toHaveLength(0);
  });
});
