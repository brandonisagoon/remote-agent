import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createPrismaClient } from "../lib/prisma.ts";
import type { PrismaClient } from "../generated/prisma/client.ts";

const MIGRATIONS_DIR = path.join(import.meta.dir, "..", "..", "prisma", "migrations");

/**
 * A real, disposable SQLite database for tests.
 *
 * Deliberately not a mock: the behavior most worth testing here is the unique
 * constraint on LinearWebhookReceipt.linearDeliveryId, which makes Linear's
 * retries idempotent. A fake store would assert our own assumptions rather
 * than the database's actual guarantee.
 *
 * The committed migration SQL is applied rather than a hand-written schema, so
 * a migration that drifts from the models fails these tests too.
 */
export interface TestDatabase {
  prisma: PrismaClient;
  cleanup: () => Promise<void>;
}

function migrationStatements(): string[] {
  // Directories only — migration_lock.toml also lives here.
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .flatMap((dir) => {
      const file = path.join(MIGRATIONS_DIR, dir, "migration.sql");
      return readFileSync(file, "utf8")
        .split(";")
        .map((statement) =>
          // Strip leading `-- CreateTable` style comments rather than skipping
          // statements that begin with one: every generated statement is
          // preceded by a comment, so skipping them would silently apply
          // nothing at all.
          statement
            .split("\n")
            .filter((line) => !line.trim().startsWith("--"))
            .join("\n")
            .trim(),
        )
        .filter(Boolean);
    });
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const dir = mkdtempSync(path.join(tmpdir(), "remote-agent-test-"));
  const file = path.join(dir, "test.sqlite");
  const prisma = createPrismaClient(`file:${file}`);

  for (const statement of migrationStatements()) {
    await prisma.$executeRawUnsafe(statement);
  }

  return {
    prisma,
    cleanup: async () => {
      await prisma.$disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
