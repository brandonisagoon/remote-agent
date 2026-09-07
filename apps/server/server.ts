import { createApp } from "./app.ts";
import { readConfig } from "../../lib/config.ts";
import { applyPragmas, createPrismaClient } from "./prisma.ts";
import { createAcpxSessionRuntime } from "./transports/acpx/index.ts";
import { startAcpIpcServer } from "./acp/ipc-server.ts";
import { acquireRuntimeOwnership } from "./services/sessions/runtime-owner.ts";
import { createPlanCaptureInterceptor } from "./services/sessions/plan-capture.ts";
import { startRuntimeEventProjection } from "./services/sessions/runtime-events/projection.ts";
import { remoteAgentMcpServer } from "./mcp/register.ts";
import { startControlSocket } from "./control-socket.ts";

const config = readConfig();
const runtimeOwnership = acquireRuntimeOwnership(config);
const prisma = createPrismaClient(config.databaseUrl);
await applyPragmas(prisma);
const agentRuntime = createAcpxSessionRuntime(prisma, config, {
  onPermissionRequest: createPlanCaptureInterceptor({ prisma, config }),
  // Every session discovers remote-agent's own tools (delegate_session,
  // register_thread) as MCP tools; they call back over the control socket.
  mcpServers: [remoteAgentMcpServer()],
});
const acpIpcServer = await startAcpIpcServer({ config, runtime: agentRuntime });
// Drains the lifecycle journal into Linear (mirror state, checkpoint
// comments) and prunes it; without this the journal grows unbounded.
const stopProjection = startRuntimeEventProjection({
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
// Same routes for same-machine callers (sessions' MCP tools, later the CLI
// and GUI), gated by socket permissions instead of the API key.
const controlSocket = await startControlSocket({
  path: config.controlIpcPath,
  app: createApp({ config, agentRuntime, prisma, trustLocal: true }),
});

console.log(`remote-agent listening on http://${config.hostname}:${config.port}`);

// Close the database explicitly on shutdown so WAL checkpoints flush rather
// than being left for the next process to recover.
async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}, shutting down`);
  await stopProjection();
  await controlSocket.close();
  await acpIpcServer.close();
  await agentRuntime.shutdown();
  await server.stop();
  await prisma.$disconnect();
  runtimeOwnership.release();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
