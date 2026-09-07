import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";

import type { Hono } from "hono";

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

/** Serves the Hono app on a unix socket for same-machine callers. Auth is
    the socket's file mode (0600): only this user's processes can connect. */
export async function startControlSocket(input: {
  path: string;
  app: Hono<any>;
}): Promise<{ close(): Promise<void> }> {
  const socketPath = path.resolve(input.path);
  mkdirSync(path.dirname(socketPath), { recursive: true });
  if (existsSync(socketPath)) {
    if (await socketIsLive(socketPath)) {
      throw new Error(`another Remote Agent server owns ${socketPath}`);
    }
    unlinkSync(socketPath);
  }
  const server = Bun.serve({ unix: socketPath, fetch: input.app.fetch });
  chmodSync(socketPath, 0o600);
  return {
    close: async () => {
      await server.stop(true);
      if (existsSync(socketPath)) unlinkSync(socketPath);
    },
  };
}
