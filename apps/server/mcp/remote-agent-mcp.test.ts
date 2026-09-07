import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.join(import.meta.dir, "remote-agent-mcp.ts");

/** Drives the stdio MCP server against a stub control socket. */
async function withServer(
  handler: (request: Request) => Response | Promise<Response>,
  run: (rpc: (message: object) => Promise<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), "remote-agent-mcp-"));
  const socketPath = path.join(directory, "control.sock");
  const server = Bun.serve({ unix: socketPath, fetch: handler });
  const child = Bun.spawn(["bun", SCRIPT], {
    env: { ...process.env, REMOTE_AGENT_SESSION_ID: "session-7", REMOTE_AGENT_SOCKET: socketPath },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let nextId = 1;
  const rpc = async (message: object) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...message })}\n`);
    await child.stdin.flush();
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.id === id) return parsed;
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("mcp server exited");
      buffer += decoder.decode(value);
    }
  };
  try {
    await run(rpc);
  } finally {
    child.kill();
    server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("remote-agent MCP server", () => {
  test("advertises tools and relays delegate_session over the socket", async () => {
    const seen: Array<{ method: string; url: string; body: unknown }> = [];
    await withServer(
      async (request) => {
        seen.push({ method: request.method, url: new URL(request.url).pathname, body: await request.json() });
        return Response.json({ sessionId: "runtime-9", name: "x › research", status: "active" }, { status: 201 });
      },
      async (rpc) => {
        const init = await rpc({ method: "initialize", params: {} });
        expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe("remote-agent");
        const list = await rpc({ method: "tools/list" });
        const names = (list.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
        expect(names).toEqual(["delegate_session", "register_thread"]);
        const call = await rpc({
          method: "tools/call",
          params: { name: "delegate_session", arguments: { prompt: "Research auth", name: "research" } },
        });
        const content = (call.result as { content: Array<{ text: string }>; isError?: boolean });
        expect(content.isError).toBeUndefined();
        expect(JSON.parse(content.content[0]!.text)).toMatchObject({ sessionId: "runtime-9" });
        expect(seen).toEqual([
          { method: "POST", url: "/api/sessions/session-7/delegate", body: { prompt: "Research auth", name: "research" } },
        ]);
      },
    );
  });

  test("surfaces server errors as tool errors", async () => {
    await withServer(
      () => Response.json({ error: "session is closed: session-7" }, { status: 400 }),
      async (rpc) => {
        const call = await rpc({ method: "tools/call", params: { name: "register_thread", arguments: { commentId: "c1" } } });
        const result = call.result as { content: Array<{ text: string }>; isError?: boolean };
        expect(result.isError).toBeTrue();
        expect(result.content[0]!.text).toContain("session is closed");
      },
    );
  });
});
