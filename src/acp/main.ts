#!/usr/bin/env bun

import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

import { BbAcpAgent } from "./agent.ts";
import { readAcpConfig } from "./config.ts";
import { acpLog } from "./log.ts";
import { createBbClient } from "../lib/transports/bb/index.ts";

export function startAcpAgent(): acp.AgentSideConnection {
  const config = readAcpConfig();
  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  return new acp.AgentSideConnection(
    (connection) => new BbAcpAgent(connection, createBbClient(config.bbBaseUrl), config),
    stream,
  );
}

if (import.meta.main) {
  try {
    startAcpAgent();
  } catch (error) {
    acpLog("startup failed", error);
    process.exitCode = 1;
  }
}
