import { afterEach, describe, expect, test } from "bun:test";

import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import {
  findAgentIssueRecordByBbThreadId,
  findAgentIssueRecordByHarnessSessionId,
  updateAgentIssueRecord,
  upsertAgentIssueRecord,
} from "./agent-issue-record.ts";

let database: TestDatabase | null = null;

afterEach(async () => {
  await database?.cleanup();
  database = null;
});

describe("AgentIssueRecord", () => {
  test("records and refreshes a canonical bb thread", async () => {
    database = await createTestDatabase();
    await upsertAgentIssueRecord(database.prisma, {
      harnessSessionId: "session-1",
      agentIssueId: "linear-1",
      agentIssueIdentifier: "AGENT-1",
      machine: "macbook-air",
      bbThreadId: "thr_initial",
    });
    await updateAgentIssueRecord(database.prisma, {
      harnessSessionId: "session-1",
      machine: "macbook-air",
      bbThreadId: "thr_current",
      lastBbEventSeq: 42,
      lastEventId: "event-2",
      lastGeneration: 2,
    });

    expect(
      await findAgentIssueRecordByHarnessSessionId(database.prisma, {
        harnessSessionId: "session-1",
      }),
    ).toMatchObject({
      agentIssueId: "linear-1",
      agentIssueIdentifier: "AGENT-1",
      bbThreadId: "thr_current",
      lastBbEventSeq: 42n,
      lastEventId: "event-2",
      lastGeneration: 2n,
    });
  });

  test("concurrent claims keep one canonical Linear issue", async () => {
    database = await createTestDatabase();
    const claims = await Promise.all([
      upsertAgentIssueRecord(database.prisma, {
        harnessSessionId: "session-1",
        agentIssueId: "linear-a",
      }),
      upsertAgentIssueRecord(database.prisma, {
        harnessSessionId: "session-1",
        agentIssueId: "linear-b",
      }),
    ]);
    expect(new Set(claims.map((claim) => claim.agentIssueId)).size).toBe(1);
  });

  test("looks up the unique bb thread locator", async () => {
    database = await createTestDatabase();
    await upsertAgentIssueRecord(database.prisma, {
      harnessSessionId: "session-1",
      agentIssueId: "linear-1",
      bbThreadId: "thr_lookup",
    });
    expect(
      await findAgentIssueRecordByBbThreadId(database.prisma, {
        bbThreadId: "thr_lookup",
      }),
    ).toMatchObject({ harnessSessionId: "session-1" });
  });

  test("subagent records deliberately carry no bb locator", async () => {
    database = await createTestDatabase();
    await upsertAgentIssueRecord(database.prisma, {
      harnessSessionId: "root:delegate",
      agentIssueId: "linear-subagent",
      machine: null,
      bbThreadId: null,
    });
    expect(
      await findAgentIssueRecordByHarnessSessionId(database.prisma, {
        harnessSessionId: "root:delegate",
      }),
    ).toMatchObject({ machine: null, bbThreadId: null });
  });
});
