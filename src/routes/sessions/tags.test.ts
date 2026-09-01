import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { PrismaClient } from "../../generated/prisma/client.ts";
import { createApp } from "../../app.ts";
import { createFakeAgentRuntime } from "../../test-support/agent-runtime.ts";
import { testConfig } from "../../test-support/config.ts";
import { createTestDatabase, type TestDatabase } from "../../test-support/db.ts";

describe("session tag API", () => {
  let database: TestDatabase;
  let prisma: PrismaClient;

  beforeEach(async () => {
    database = await createTestDatabase();
    prisma = database.prisma;
  });

  afterEach(async () => {
    await database.cleanup();
  });

  test("edits through repository definitions with optimistic revisions", async () => {
    const base = testConfig().repository;
    const repository = {
      ...base,
      metadata: {
        tags: {
          "example.kind": {
            options: ["planning", "implementation"],
            cardinality: "one" as const,
            routerVisible: true,
          },
        },
      },
    };
    const config = testConfig({
      repository,
      repositories: { [repository.id]: repository },
    });
    await prisma.runtimeSession.create({
      data: {
        id: "session-one",
        scopeKey: "scope-one",
        agentCommand: "codex",
        repositoryId: repository.id,
        machineId: "macbook-air",
        cwd: repository.root,
        status: "idle",
      },
    });
    const app = createApp({
      config,
      prisma,
      agentRuntime: createFakeAgentRuntime(),
    });
    const headers = {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    };

    const updated = await app.request("/api/sessions/session-one/tags", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        key: "example.kind",
        values: ["implementation"],
        expectedRevision: 0,
      }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ revision: 1 });

    const conflict = await app.request("/api/sessions/session-one/tags", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        key: "example.kind",
        values: ["planning"],
        expectedRevision: 0,
      }),
    });
    expect(conflict.status).toBe(409);

    const listed = await app.request("/api/sessions/session-one/tags", {
      headers: { authorization: `Bearer ${config.apiKey}` },
    });
    expect(await listed.json()).toMatchObject({
      revision: 1,
      tags: [{ key: "example.kind", value: "implementation", unlisted: false }],
    });

    const inspected = await app.request("/api/sessions/session-one", {
      headers: { authorization: `Bearer ${config.apiKey}` },
    });
    expect(await inspected.json()).toMatchObject({
      session: {
        id: "session-one",
        repositoryId: repository.id,
        tags: [{ key: "example.kind", value: "implementation" }],
        outgoingRelations: [],
        incomingRelations: [],
        resourceLinks: [],
      },
    });
  });
});
