import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFakeAgentRuntime } from "../../test-support/agent-runtime.ts";
import { testConfig } from "../../test-support/config.ts";
import { createApp } from "./app.ts";
import { startControlSocket } from "./control-socket.ts";

describe("control socket", () => {
  test("serves the app without bearer auth, owner-only, and cleans up", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "remote-agent-control-"));
    const socketPath = path.join(directory, "control.sock");
    const config = testConfig();
    const runtime = createFakeAgentRuntime();
    const local = createApp({ config, agentRuntime: runtime, prisma: {} as never, trustLocal: true });
    const remote = createApp({ config, agentRuntime: runtime, prisma: {} as never });
    const socket = await startControlSocket({ path: socketPath, app: local });
    try {
      expect(statSync(socketPath).mode & 0o777).toBe(0o600);
      // Over the socket: no key needed, request reaches validation.
      const response = await fetch("http://remote-agent/api/launches", {
        method: "POST",
        unix: socketPath,
      } as RequestInit);
      expect(response.status).toBe(400);
      // The network app still demands the key.
      const denied = await remote.request("/api/launches", { method: "POST" });
      expect(denied.status).toBe(401);
    } finally {
      await socket.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
