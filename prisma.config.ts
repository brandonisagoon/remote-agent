import { readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "prisma/config";

function databaseUrl(): string {
  const selected = process.env.REMOTE_AGENT_CONFIG?.trim();
  if (!selected) return `file:${path.join(__dirname, "dev.sqlite")}`;

  const configFile = path.resolve(selected);
  const config = JSON.parse(readFileSync(configFile, "utf8")) as {
    server?: { databaseUrl?: string };
  };
  const configured = config.server?.databaseUrl;
  if (!configured) {
    return `file:${path.join(path.dirname(configFile), "remote-agent.sqlite")}`;
  }
  if (!configured.startsWith("file:")) return configured;
  const file = configured.slice("file:".length);
  return `file:${path.resolve(path.dirname(configFile), file)}`;
}

export default defineConfig({
  schema: path.join(__dirname, "prisma", "schema"),
  migrations: {
    path: path.join(__dirname, "prisma", "migrations"),
  },
  datasource: {
    url: databaseUrl(),
  },
});
