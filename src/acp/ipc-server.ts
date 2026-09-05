import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

import type { ServerConfig } from "../lib/config.ts";
import type { AgentSessionRuntime } from "../types/runtime/index.ts";
import { RemoteAgentAcpAgent } from "./agent.ts";

async function socketIsLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

export async function startAcpIpcServer(input: {
  config: ServerConfig;
  runtime: AgentSessionRuntime;
}): Promise<{ close(): Promise<void> }> {
  const socketPath = path.resolve(input.config.acpIpcPath);
  if (socketPath === path.parse(socketPath).root) {
    throw new Error("ACP IPC path cannot be a filesystem root");
  }
  mkdirSync(path.dirname(socketPath), { recursive: true });
  if (existsSync(socketPath)) {
    if (await socketIsLive(socketPath)) {
      throw new Error(`another Remote Agent daemon owns ${socketPath}`);
    }
    unlinkSync(socketPath);
  }

  const connections = new Set<acp.AgentSideConnection>();
  const server = createServer((socket) => {
    const stream = acp.ndJsonStream(
      Writable.toWeb(socket),
      Readable.toWeb(socket) as unknown as ReadableStream<Uint8Array>,
    );
    const connection = new acp.AgentSideConnection(
      (client) => new RemoteAgentAcpAgent(client, input.runtime, input.config),
      stream,
    );
    connections.add(connection);
    socket.once("close", () => connections.delete(connection));
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
  chmodSync(socketPath, 0o600);

  return {
    close: async () => {
      await closeServer(server);
      if (existsSync(socketPath)) unlinkSync(socketPath);
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
