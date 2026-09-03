import { describe, expect, test } from "bun:test";

import { testConfig } from "../../../../test-support/config.ts";
import {
  buildAgentIssueDescription,
  isEligibleCandidate,
  sourceIssueIdentifierFromBranch,
  parseAgentIssueRuntime,
  parseAgentIssueSyncMetadata,
  type RouteCandidate,
  workflowLabelForEvent,
} from "../index.ts";

const DESCRIPTION = `<!-- remote-agent-session:v1 -->
| Runtime field | Value |
| --- | --- |
| Harness session ID | \`thr_abc123\` |
| Worktree | \`/srv/worktrees/example-cube-2600\` |
| Lifecycle | — |
| Runtime session ID | \`runtime-example-1\` |
| Execution target | \`Test MacBook Air\` |
<!-- /remote-agent-session:v1 -->
<!-- remote-agent-sync:v1 {"eventId":"evt-1","generation":42,"occurredAt":"2026-07-28T12:00:00.000Z","sourceKey":"Q1VCRS0yNjAw"} -->

>>> ## Open Session
details are intentionally ignored by the parser
>>>`;

describe("agent issue description", () => {
  test("parses only the managed runtime table", () => {
    expect(parseAgentIssueRuntime(DESCRIPTION)).toEqual({
      harnessSessionId: "thr_abc123",
      parentSessionId: null,
      worktreePath: "/srv/worktrees/example-cube-2600",
      branchName: null,
      harness: "codex",
      machine: "macbook-air",
      role: "primary",
      lifecycle: null,
      runtimeSessionId: "runtime-example-1",
    });
  });

  test("parses the hidden idempotency metadata independently", () => {
    expect(parseAgentIssueSyncMetadata(DESCRIPTION)).toEqual({
      eventId: "evt-1",
      generation: 42,
      occurredAt: "2026-07-28T12:00:00.000Z",
      sourceIssueIdentifier: "CUBE-2600",
    });
  });

  test("rejects descriptions without both identity and worktree", () => {
    expect(parseAgentIssueRuntime("ordinary issue description")).toBeNull();
  });

  test("writes lifecycle metadata and a collapsed open section", () => {
    const description = buildAgentIssueDescription(
      {
        harnessSessionId: "thr_abc123",
        parentSessionId: null,
        worktreePath: "/srv/worktrees/example-cube-2600",
        branchName: "example-cube-2600",
        harness: "codex",
        machine: "macbook-air",
        role: "primary",
        lifecycle: "one-shot",
        runtimeSessionId: "runtime-2600",
      },
      {
        eventId: "evt-2",
        generation: 43,
        occurredAt: "2026-07-28T12:01:00.000Z",
        sourceIssueIdentifier: "CUBE-2600",
      },
      testConfig({ editorConnection: "ssh" }),
    );
    expect(description).toContain(
      "| Worktree | `/srv/worktrees/example-cube-2600` |",
    );
    expect(description).toContain("| Lifecycle | `one-shot` |");
    expect(description).toContain("| Source issue | `CUBE-2600` |");
    expect(description).toContain("+++ Open Session");
    expect(description).toContain(
      "[Open Worktree in Zed](zed://ssh/test-remote/srv/worktrees/example-cube-2600)",
    );
    expect(description).toContain("acpx session `runtime-2600`");
    expect(description).not.toContain("<!-- remote-agent-");
    expect(description).not.toContain("| Machine |");
    expect(description).not.toContain("| Branch |");
  });
});

describe("source issue resolution", () => {
  test("derives the issue from the branch suffix", () => {
    expect(sourceIssueIdentifierFromBranch("remote-agent-server-cube-2600")).toBe(
      "CUBE-2600",
    );
    expect(sourceIssueIdentifierFromBranch("feature-demo-42")).toBe("DEMO-42");
    expect(
      sourceIssueIdentifierFromBranch("feature-without-an-issue"),
    ).toBeNull();
  });
});

describe("delivery eligibility", () => {
  const config = testConfig({ editorConnection: "ssh" });
  const candidate: RouteCandidate = {
    agentIssueId: "issue-id",
    agentIssueIdentifier: "AGENT-9",
    status: "Connected",
    assigneeId: config.agentUserId,
    labels: [
      "Codex",
      "Primary",
      "Accepts Linear Input",
      "Test MacBook Air",
    ],
    runtime: {
      harnessSessionId: "thr_abc123",
      parentSessionId: null,
      worktreePath: "/tmp/worktree",
      branchName: null,
      harness: "codex",
      machine: "macbook-air",
      role: "primary",
      runtimeSessionId: "runtime-agent",
    },
  };

  test("uses runtime state rather than Linear ownership metadata", () => {
    expect(isEligibleCandidate(config, candidate)).toBeTrue();
    expect(
      isEligibleCandidate(config, { ...candidate, status: "Disconnected" }),
    ).toBeFalse();
    expect(
      isEligibleCandidate(config, { ...candidate, assigneeId: "someone-else" }),
    ).toBeTrue();
    expect(
      isEligibleCandidate(config, { ...candidate, labels: [] }),
    ).toBeTrue();
    expect(
      isEligibleCandidate(config, {
        ...candidate,
        runtime: { ...candidate.runtime, runtimeSessionId: null },
      }),
    ).toBeFalse();
    expect(
      isEligibleCandidate(config, {
        ...candidate,
        runtime: { ...candidate.runtime, role: "delegate" },
      }),
    ).toBeFalse();
  });
});

describe("Workflow labels", () => {
  test("a workflow start replaces all previous Workflow labels", () => {
    expect(
      workflowLabelForEvent(
        { type: "workflow.started", workflow: "reflect-linear" },
        ["General", "plan-linear", "orchestrate-plan-linear"],
      ),
    ).toBe("reflect-linear");
  });

  test("ending the current workflow returns the session to General", () => {
    expect(
      workflowLabelForEvent(
        { type: "workflow.ended", workflow: "plan-linear" },
        ["plan-linear"],
      ),
    ).toBe("General");
  });

  test("ending another workflow preserves the current workflow", () => {
    expect(
      workflowLabelForEvent(
        { type: "workflow.ended", workflow: "plan-linear" },
        ["reflect-linear"],
      ),
    ).toBe("reflect-linear");
  });

  test("ordinary events repair ambiguous legacy Workflow labels", () => {
    expect(
      workflowLabelForEvent({ type: "runtime.refresh" }, [
        "plan-linear",
        "reflect-linear",
      ]),
    ).toBe("General");
  });
});
