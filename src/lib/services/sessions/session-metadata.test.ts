import { afterEach, describe, expect, test } from "bun:test";

import type { RepositoryConfig } from "../../config.ts";
import { testConfig } from "../../../test-support/config.ts";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../../test-support/db.ts";
import { beginRuntimeSession } from "./runtime-registry.ts";
import {
  readSessionLabels,
  removeSessionLabel,
  resolveInitialSessionLabels,
  setSessionLabel,
} from "./session-metadata.ts";

let database: TestDatabase | null = null;

afterEach(async () => {
  await database?.cleanup();
  database = null;
});

function repository(
  id: string,
  options: string[],
): RepositoryConfig {
  return {
    id,
    name: id,
    root: `/tmp/${id}`,
    worktreeRoot: `/tmp/${id}-worktrees`,
    bootstrapCommand: ["true"],
    skillsRoot: "agent-skills",
    workflows: {},
    labels: {
      "example.kind": {
        labels: options,
        exclusive: true,
        routerVisible: true,
      },
      "example.skill": {
        exclusive: false,
        routerVisible: true,
      },
    },
    sessionDefaults: {
      labels: { "example.kind": [options[0]!] },
    },
  };
}

describe("repository session metadata", () => {
  test("resolves defaults and explicit strings using only the owning repository", () => {
    const first = repository("first", ["planning", "implementation"]);
    const second = repository("second", ["review"]);
    expect(resolveInitialSessionLabels(first, {
      "example.kind": ["implementation"],
      "example.skill": ["typescript", "agents"],
    })).toEqual([
      { key: "example.kind", value: "implementation", source: "launch" },
      { key: "example.skill", value: "agents", source: "launch" },
      { key: "example.skill", value: "typescript", source: "launch" },
    ]);
    expect(() => resolveInitialSessionLabels(second, {
      "example.kind": ["implementation"],
    })).toThrow("not configured for repository second");
  });

  test("persists opaque strings and edits them with optimistic revision", async () => {
    database = await createTestDatabase();
    const repo = repository("first", ["planning", "implementation"]);
    const config = testConfig({
      repository: repo,
      repositories: { first: repo },
      activeRepositoryId: "first",
    });
    const session = await beginRuntimeSession(database.prisma, {
      sessionKey: "metadata",
      agent: "codex",
      cwd: repo.root,
      repositoryId: repo.id,
      machineId: "macbook-air",
      role: "primary",
    }, {
      labels: resolveInitialSessionLabels(repo),
    });

    expect(await readSessionLabels(database.prisma, session.id)).toEqual({
      revision: 0,
      tags: { "example.kind": ["planning"] },
    });
    const updated = await setSessionLabel(database.prisma, config, {
      runtimeSessionId: session.id,
      key: "example.kind",
      values: ["implementation"],
      source: "operator-test",
      expectedRevision: 0,
    });
    expect(updated).toEqual({
      revision: 1,
      tags: { "example.kind": ["implementation"] },
    });
    await expect(setSessionLabel(database.prisma, config, {
      runtimeSessionId: session.id,
      key: "example.kind",
      values: ["planning"],
      source: "operator-test",
      expectedRevision: 0,
    })).rejects.toThrow("revision conflict");
    expect(await removeSessionLabel(database.prisma, config, {
      runtimeSessionId: session.id,
      key: "example.kind",
      source: "operator-test",
      expectedRevision: 1,
    })).toEqual({ revision: 2, tags: {} });
    expect(await database.prisma.runtimeMetadataEvent.count()).toBe(2);
  });

  test("stores relationships and connection-aware resource links at creation", async () => {
    database = await createTestDatabase();
    const parent = await beginRuntimeSession(database.prisma, {
      sessionKey: "parent",
      agent: "codex",
      cwd: "/tmp/first",
      repositoryId: "first",
      machineId: "macbook-air",
      role: "primary",
    });
    const child = await beginRuntimeSession(database.prisma, {
      sessionKey: "child",
      agent: "codex",
      cwd: "/tmp/first-worktrees/child",
      repositoryId: "first",
      machineId: "macbook-air",
      role: "delegate",
      relations: [{ relationship: "spawned-by", targetSessionId: parent.id }],
      resourceLinks: [{
        provider: "linear",
        connectionId: "linear-main",
        resourceType: "issue-identifier",
        externalId: "RA-42",
        relationship: "handles",
      }],
    });
    expect(await database.prisma.runtimeSessionRelation.findFirst({
      where: { sourceSessionId: child.id },
    })).toMatchObject({ targetSessionId: parent.id, relationship: "spawned-by" });
    expect(await database.prisma.runtimeSessionResourceLink.findFirst({
      where: { runtimeSessionId: child.id },
    })).toMatchObject({ connectionId: "linear-main", externalId: "RA-42" });
  });
});
