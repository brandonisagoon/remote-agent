import { createApp } from "./app.ts";
import { readConfig } from "./lib/config.ts";
import { applyPragmas, createPrismaClient } from "./lib/prisma.ts";
import {
  reconcileMachineSessions,
  startRuntimeEventProjection,
} from "./lib/services/sessions/index.ts";
import { createAcpxSessionRuntime } from "./lib/transports/acpx/index.ts";

const config = readConfig();
const prisma = createPrismaClient(config.databaseUrl);
await applyPragmas(prisma);
const agentRuntime = createAcpxSessionRuntime(prisma, config);
const stopRuntimeProjection = startRuntimeEventProjection({
  config,
  prisma,
  runtime: agentRuntime,
});

const app = createApp({ config, agentRuntime, prisma });

const server = Bun.serve({
  hostname: config.hostname,
  port: config.port,
  fetch: app.fetch,
});

console.log(`remote-agent listening on http://${config.hostname}:${config.port}`);

let reconcileTimer: ReturnType<typeof setInterval> | null = null;

async function reconcileSessions(): Promise<void> {
  try {
    const { connected, disconnected, ended } =
      await reconcileMachineSessions(config, agentRuntime);
    if (connected || disconnected || ended) {
      console.log(
        `[sessions] startup reconciliation connected=${connected} disconnected=${disconnected} ended=${ended}`,
      );
    }
  } catch (error) {
    console.error("[sessions] acpx reconciliation failed:", error);
  }

}

void reconcileSessions();
reconcileTimer = setInterval(
  () => void reconcileSessions(),
  config.acpxReconcileIntervalMs,
);

// Close the database explicitly on shutdown so WAL checkpoints flush rather
// than being left for the next process to recover.
async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}, shutting down`);
  if (reconcileTimer) clearInterval(reconcileTimer);
  await stopRuntimeProjection();
  await agentRuntime.shutdown();
  await server.stop();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
