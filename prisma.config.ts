import path from "node:path";
import { defineConfig } from "prisma/config";

// REMOTE_AGENT_DATABASE_URL keeps this service's SQLite database isolated from
// any database variables used by the configured host repository.
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
