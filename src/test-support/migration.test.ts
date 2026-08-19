import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import type { PrismaClient } from "../generated/prisma/client.ts";
import { createPrismaClient } from "../lib/prisma.ts";

const MIGRATIONS = path.join(import.meta.dir, "..", "..", "prisma", "migrations");
const directories = [
  "20260727213830_init",
  "20260728004654_reflection_threads",
  "20260728004706_thread_root_indexes",
  "20260729003351_linear_session_registry",
  "20260730215309_linear_webhook_receipts_and_worker_runs",
  "20260731153959_create_session_issue_map",
  "20260731162947_rename_session_issue_map_to_session_issue",
  "20260731180904_rename_issue_entities",
  "20260812210949_bb_transport",
  "20260813222942_bb_error_threading",
  "20260819120739_rename_cube_issue_to_source_issue",
];

function statements(directory: string): string[] {
  return readFileSync(path.join(MIGRATIONS, directory, "migration.sql"), "utf8")
    .split(";")
    .map((statement) =>
      statement
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
}

describe("receipt and worker-run migration", () => {
  let prisma: PrismaClient | null = null;
  let directory: string | null = null;

  afterEach(async () => {
    await prisma?.$disconnect();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  test("preserves ignored intake and completed delivery history", async () => {
    directory = mkdtempSync(path.join(tmpdir(), "remote-agent-migration-"));
    prisma = createPrismaClient(`file:${path.join(directory, "test.sqlite")}`);
    for (const migration of directories.slice(0, 4)) {
      for (const statement of statements(migration)) {
        await prisma.$executeRawUnsafe(statement);
      }
    }
    await prisma.$executeRawUnsafe(`
      INSERT INTO "Delivery"
        ("deliveryId", "eventType", "issueIdentifier", "commentId", "targetAgentIssue", "outcome", "detail", "createdAt", "updatedAt")
      VALUES
        ('ignored-1', 'mention', 'CUBE-1', 'comment-1', NULL, 'ignored', 'self_authored', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('delivered-1', 'reflection', 'CUBE-2', NULL, 'AGENT-9', 'delivered', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    for (const migration of directories.slice(4, -4)) {
      for (const statement of statements(migration)) {
        await prisma.$executeRawUnsafe(statement);
      }
    }
    await prisma.$executeRawUnsafe(`
      INSERT INTO "SessionIssue"
        ("id", "harnessSessionId", "linearIssueId", "linearIssueIdentifier", "machine", "tmuxSession", "tmuxPane", "lastEventId", "lastGeneration", "createdAt", "updatedAt")
      VALUES
        ('record-1', 'session-1', 'agent-issue-id', 'AGENT-9', 'macbook-air', 'tmux-1', '%1', 'event-1', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    for (const migration of directories.slice(-4)) {
      for (const statement of statements(migration)) {
        await prisma.$executeRawUnsafe(statement);
      }
    }

    const receipts = await prisma.linearWebhookReceipt.findMany({
      orderBy: { linearDeliveryId: "asc" },
    });
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({
      linearDeliveryId: "delivered-1",
      eventType: "issue",
      trigger: "reflection",
      sourceIssueIdentifier: "CUBE-2",
      status: "accepted",
    });
    expect(receipts[1]).toMatchObject({
      linearDeliveryId: "ignored-1",
      eventType: "comment",
      trigger: "mention",
      status: "ignored",
      detail: "self_authored",
    });
    expect(await prisma.workerRun.findMany()).toEqual([
      expect.objectContaining({
        receiptId: "delivered-1",
        workerKey: "product.reflection",
        status: "delivered",
        targetAgentIssueIdentifier: "AGENT-9",
      }),
    ]);
    expect(await prisma.agentIssueRecord.findUnique({
      where: { harnessSessionId: "session-1" },
    })).toMatchObject({
      agentIssueId: "agent-issue-id",
      agentIssueIdentifier: "AGENT-9",
      lastEventId: "event-1",
      lastGeneration: 2n,
    });
  });
});
