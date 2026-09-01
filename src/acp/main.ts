#!/usr/bin/env bun

import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

import { RemoteAgentAcpAgent } from "./agent.ts";
import { acpLog } from "./log.ts";
import { readConfig } from "../lib/config.ts";
import { applyPragmas, createPrismaClient } from "../lib/prisma.ts";
import { createAcpxSessionRuntime } from "../lib/transports/acpx/index.ts";

export async function startAcpAgent(): Promise<acp.AgentSideConnection> {
  const config = readConfig();
  const prisma = createPrismaClient(config.databaseUrl);
  await applyPragmas(prisma);
  const runtime = createAcpxSessionRuntime(prisma, config);
  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  return new acp.AgentSideConnection(
    (connection) => new RemoteAgentAcpAgent(connection, runtime, config),
    stream,
  );
}

if (import.meta.main) {
  try {
    await startAcpAgent();
  } catch (error) {
    acpLog("startup failed", error);
    process.exitCode = 1;
  }
}
