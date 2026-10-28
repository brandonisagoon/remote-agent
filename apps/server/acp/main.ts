#!/usr/bin/env bun

import { createConnection } from "node:net";
import { parseArgs } from "node:util";

import { readConfig } from "../../../lib/config.ts";
import { acpLog } from "./log.ts";
import { startMultiServerBridge } from "./multi-server-bridge.ts";

/** Stateless ACP stdio bridge for any ACP client (Zed, bb, T3 Code…). The machine server is the sole runtime and
 * database owner. Multiple explicit configs expose their original sessions through one entry. */
export async function startAcpBridge(configFiles: string[] = []): Promise<void> {
  const configs = configFiles.length ? configFiles.map((file) => readConfig(file)) : [readConfig()];
  if (configs.length > 1) return startMultiServerBridge(configs);
  const config = configs[0]!;
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
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { config: { type: "string", multiple: true } },
    });
    await startAcpBridge(values.config);
  } catch (error) {
    acpLog("bridge failed", error);
    process.exitCode = 1;
  }
}
