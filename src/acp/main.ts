#!/usr/bin/env bun

import { createConnection } from "node:net";

import { readConfig } from "../lib/config.ts";
import { acpLog } from "./log.ts";

/** Stateless Zed ACP stdio bridge. The machine daemon is the sole runtime and
 * database owner; this process only forwards framed NDJSON bytes. */
export async function startAcpBridge(): Promise<void> {
  const config = readConfig();
  const socket = createConnection(config.acpIpcPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  await new Promise<void>((resolve, reject) => {
    socket.once("close", resolve);
    socket.once("error", reject);
  });
}

if (import.meta.main) {
  try {
    await startAcpBridge();
  } catch (error) {
    acpLog("bridge failed", error);
    process.exitCode = 1;
  }
}
