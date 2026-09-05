import { createApp } from "./app.ts";
import { readConfig } from "./lib/config.ts";
import { applyPragmas, createPrismaClient } from "./lib/prisma.ts";
import { createAcpxSessionRuntime } from "./lib/transports/acpx/index.ts";
import { startAcpIpcServer } from "./acp/ipc-server.ts";
import { acquireRuntimeOwnership } from "./lib/services/sessions/runtime-owner.ts";
import { createPlanCaptureInterceptor } from "./lib/services/sessions/plan-capture.ts";

const config = readConfig();
const runtimeOwnership = acquireRuntimeOwnership(config);
const prisma = createPrismaClient(config.databaseUrl);
await applyPragmas(prisma);
const agentRuntime = createAcpxSessionRuntime(prisma, config, {
  onPermissionRequest: createPlanCaptureInterceptor({ prisma, config }),
});
const acpIpcServer = await startAcpIpcServer({ config, runtime: agentRuntime });

const app = createApp({ config, agentRuntime, prisma });

const server = Bun.serve({
  hostname: config.hostname,
  port: config.port,
  fetch: app.fetch,
});

console.log(`remote-agent listening on http://${config.hostname}:${config.port}`);

// Close the database explicitly on shutdown so WAL checkpoints flush rather
// than being left for the next process to recover.
async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}, shutting down`);
  await acpIpcServer.close();
  await agentRuntime.shutdown();
  await server.stop();
  await prisma.$disconnect();
  runtimeOwnership.release();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
