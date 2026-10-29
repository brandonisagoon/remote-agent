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

  // publish_issue_update sends a JSON body and may prepare video for longer
  // than Bun's 10-second idle default. Real processes, as in production: the
  // control socket server and the session's MCP stdio client.
  test("a long JSON publication through the MCP client returns its result after the 10-second idle default", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "remote-agent-control-"));
    const socketPath = path.join(directory, "control.sock");
    const server = Bun.spawn([process.execPath, "--no-env-file", path.join(import.meta.dir, "..", "..", "test-support", "delayed-control-socket.ts"), socketPath, "16000"], { stdout: "pipe", stderr: "ignore" });
    const mcp = Bun.spawn([process.execPath, "--no-env-file", path.join(import.meta.dir, "mcp", "remote-agent-mcp.ts")], {
      env: { ...process.env, REMOTE_AGENT_SESSION_ID: "session-1", REMOTE_AGENT_SOCKET: socketPath }, stdin: "pipe", stdout: "pipe", stderr: "ignore",
    });
    // Every read has a deadline inside the test timeout and a bounded buffer.
    const firstLine = async (stream: ReadableStream<Uint8Array>, ms: number) => {
      const reader = stream.getReader();
      const deadline = Date.now() + ms;
      let buffer = "";
      try {
        while (!buffer.includes("\n")) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no line within ${ms} ms`)), Math.max(0, deadline - Date.now())); });
          const read = await Promise.race([reader.read(), expired]).finally(() => clearTimeout(timer));
          if (read.done) throw new Error("stream ended before a line");
          buffer += new TextDecoder().decode(read.value);
          if (buffer.length > 64 * 1024) throw new Error("line exceeds 64 KiB");
        }
        return buffer.slice(0, buffer.indexOf("\n"));
      } finally { reader.releaseLock(); }
    };
    try {
      expect(await firstLine(server.stdout, 10_000)).toBe("ready");
      const started = Date.now();
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "publish_issue_update", arguments: { requestKey: "review", body: "Done" } } })}\n`);
      const message = JSON.parse(await firstLine(mcp.stdout, 25_000));
      const elapsed = Date.now() - started;
      expect(message).toMatchObject({ id: 1, result: { content: [{ text: JSON.stringify({ published: true, sessionId: "session-1" }) }] } });
      expect(message.result.isError).toBeUndefined();
      expect(elapsed).toBeGreaterThanOrEqual(16_000);
    } finally {
      mcp.kill();
      server.kill();
      await Promise.all([mcp.exited, server.exited]);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 40_000);
});
