import { afterEach, describe, expect, test } from "bun:test";

import type { RepositoryConfig } from "../../../config.ts";
import { testConfig } from "../../../../test-support/config.ts";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../../../test-support/db.ts";
import { beginRuntimeSession, updateRuntimeSessionState } from "../runtime-registry.ts";
import { fetchRouteCandidates, isEligibleCandidate } from "./find-candidates.ts";

let database: TestDatabase | null = null;

afterEach(async () => {
  await database?.cleanup();
  database = null;
});

function repo(): RepositoryConfig {
  const base = testConfig().repository;
  return {
    ...base,
    id: "repo-one",
    root: "/tmp/repo-one",
    worktreeRoot: "/tmp/repo-one-worktrees",
    labels: {
      "example.visible": { exclusive: false, routerVisible: true },
      "example.private": { exclusive: false, routerVisible: false },
    },
  };
}

describe("registry-backed route candidates", () => {
  test("discovers linked sessions without Linear Agent-team issues", async () => {
    database = await createTestDatabase();
    const repository = repo();
    const config = testConfig({
      repository,
      repositories: { [repository.id]: repository },
      activeRepositoryId: repository.id,
    });
    const session = await beginRuntimeSession(database.prisma, {
      sessionKey: "route",
      agent: "codex",
      cwd: repository.root,
      repositoryId: repository.id,
      machineId: "macbook-air",
      role: "primary",
      lifecycle: "persistent",
      resourceLinks: [{
        provider: "linear",
        connectionId: config.activeConnectionId,
        resourceType: "issue-identifier",
        externalId: "RA-42",
        relationship: "handles",
      }],
    }, {
      labels: [
        { key: "example.visible", value: "runtime", source: "launch" },
        { key: "example.private", value: "secret", source: "launch" },
      ],
    });
    await updateRuntimeSessionState(database.prisma, session.id, { status: "idle" });

    const candidates = await fetchRouteCandidates(
      config,
      database.prisma,
      "RA-42",
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      agentIssueIdentifier: session.id,
      labels: ["example.visible:runtime"],
      runtime: { runtimeSessionId: session.id, role: "primary" },
    });
    expect(isEligibleCandidate(config, candidates[0]!)).toBe(true);
  });

  test("keeps connections and repositories isolated", async () => {
    database = await createTestDatabase();
    const repository = repo();
    const config = testConfig({
      repository,
      repositories: { [repository.id]: repository },
      activeRepositoryId: repository.id,
    });
    await beginRuntimeSession(database.prisma, {
      sessionKey: "wrong-connection",
      agent: "codex",
      cwd: repository.root,
      repositoryId: repository.id,
      machineId: "macbook-air",
      role: "primary",
      resourceLinks: [{
        provider: "linear",
        connectionId: "another-linear-workspace",
        resourceType: "issue-identifier",
        externalId: "RA-42",
        relationship: "handles",
      }],
    });
    expect(await fetchRouteCandidates(config, database.prisma, "RA-42")).toEqual([]);
  });
});
