import { PrismaLibSql } from "@prisma/adapter-libsql";

import { PrismaClient } from "../generated/prisma/client.ts";

/**
 * Prisma over libSQL.
 *
 * Deliberately NOT @prisma/adapter-better-sqlite3: better-sqlite3 is a native
 * Node addon that fails under Bun with ERR_DLOPEN_FAILED
 * (https://github.com/oven-sh/bun/issues/4290). libSQL is the adapter that
 * actually works on this runtime.
 */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  const adapter = new PrismaLibSql({ url: databaseUrl });
  return new PrismaClient({ adapter });
}

/**
 * WAL lets a reader run while a writer holds the file, which matters because
 * webhook handling and the state API touch the database concurrently. The
 * busy timeout stops a brief writer lock from surfacing as a 500.
 */
export async function applyPragmas(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe("PRAGMA journal_mode = WAL");
  await prisma.$executeRawUnsafe("PRAGMA busy_timeout = 5000");
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys = ON");
}
