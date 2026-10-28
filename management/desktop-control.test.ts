import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { desktopControl } from "./desktop-control.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function endpoint(handler: RequestListener) {
  const directory = mkdtempSync(path.join(tmpdir(), "ra-control-"));
  const socket = path.join(directory, "ipc");
  const server = createServer(handler);
  const connections = new Set<Socket>();
  server.on("connection", (connection) => {
    connections.add(connection);
    connection.on("close", () => connections.delete(connection));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  cleanups.push(async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const connection of connections) connection.destroy();
    server.closeAllConnections();
    await closed;
    rmSync(directory, { recursive: true, force: true });
  });
  return socket;
}

test("control client preserves route, method and idempotency body", async () => {
  const received: unknown[] = [];
  const socket = await endpoint(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push({ route: request.url, method: request.method, body: JSON.parse(body) });
    response.end(JSON.stringify({ accepted: true }));
  });
  expect(await desktopControl<{ accepted: boolean }>(socket, "/api/tasks/task/instructions", "POST", { requestKey: "stable", text: "continue" }, 1000)).toEqual({ accepted: true });
  expect(received).toEqual([{ route: "/api/tasks/task/instructions", method: "POST", body: { requestKey: "stable", text: "continue" } }]);
});

test("silent control server hits total deadline without replaying an uncertain write", async () => {
  let requests = 0;
  const socket = await endpoint(() => { requests++; });
  await expect(desktopControl(socket, "/write", "POST", { requestKey: "once" }, 150)).rejects.toThrow("inspect state before repeating");
  expect(requests).toBe(1);
});

test("response traffic cannot extend the total control deadline", async () => {
  let writes = 0;
  const socket = await endpoint((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write("{");
    const timer = setInterval(() => { writes++; response.write(" "); }, 10);
    response.on("close", () => clearInterval(timer));
  });
  await expect(desktopControl(socket, "/trickle", "GET", undefined, 150)).rejects.toThrow("timed out");
  expect(writes).toBeGreaterThan(0);
}, 2000);

test("interrupted response rejects instead of leaving the caller pending", async () => {
  const socket = await endpoint((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"partial":');
    setTimeout(() => response.destroy(), 10);
  });
  await expect(desktopControl(socket, "/aborted", "GET", undefined, 1000)).rejects.toThrow();
});

test("control errors and invalid JSON reject, while subsequent requests still work", async () => {
  const socket = await endpoint((request, response) => {
    if (request.url === "/error") { response.writeHead(409); response.end('{"error":"Task is paused"}'); }
    else if (request.url === "/invalid") response.end("not-json");
    else response.end('{"ok":true}');
  });
  await expect(desktopControl(socket, "/error")).rejects.toThrow("Task is paused");
  await expect(desktopControl(socket, "/invalid")).rejects.toThrow();
  expect(await desktopControl<{ ok: boolean }>(socket, "/ok")).toEqual({ ok: true });
});

test("control response limit counts bytes rather than UTF-16 characters", async () => {
  const socket = await endpoint((_request, response) => response.end(JSON.stringify("界".repeat(2_700_000))));
  await expect(desktopControl(socket, "/large", "GET", undefined, 2000)).rejects.toThrow("Response exceeds desktop limit");
});

test("invalid deadlines reject without opening a connection", async () => {
  for (const timeout of [0, -1, NaN, Infinity, 2_147_483_648]) {
    await expect(desktopControl("unused", "/", "GET", undefined, timeout)).rejects.toThrow("finite positive");
  }
});
