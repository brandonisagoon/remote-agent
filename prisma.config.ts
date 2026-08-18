import path from "node:path";
import { defineConfig } from "prisma/config";

// Deliberately isolated from the repository-root prisma.config.ts. The Prisma
// CLI resolves this file from the current working directory, so every script
// here must run with the remote-agent repository as cwd.
//
// REMOTE_AGENT_DATABASE_URL, never DATABASE_URL: the latter is already a Neon
// Postgres URL in .env.development.local, and reusing it would aim this SQLite
// datasource at the product database.
const databaseUrl =
  process.env.REMOTE_AGENT_DATABASE_URL?.trim() ||
  `file:${path.join(__dirname, "dev.sqlite")}`;

export default defineConfig({
  schema: path.join(__dirname, "prisma", "schema"),
  migrations: {
    path: path.join(__dirname, "prisma", "migrations"),
  },
  datasource: {
    url: databaseUrl,
  },
});
