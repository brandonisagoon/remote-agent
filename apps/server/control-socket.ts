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
  // Bun 1.3.14 ignores server.timeout(request, ...) for Unix listeners. Keep
  // the owner-only transport bounded above the authenticated adoption deadline
  // (240s) plus its response margin; per-request deadlines remain in handlers.
  const options = { unix: socketPath, idleTimeout: 255, fetch: input.app.fetch };
  // bun-types exposes idleTimeout only on TCP options; the installed Unix
  // implementation accepts it (covered by the real TCP/Unix route regression).
  const server = Bun.serve(options as Omit<typeof options, "idleTimeout">);
  chmodSync(socketPath, 0o600);
  return {
    close: async () => {
      await server.stop(true);
      if (existsSync(socketPath)) unlinkSync(socketPath);
    },
  };
}
