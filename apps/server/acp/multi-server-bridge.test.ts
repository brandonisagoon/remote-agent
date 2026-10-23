import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";

import { testConfig } from "../../../test-support/config.ts";
import { startMultiServerBridge } from "./multi-server-bridge.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(roots: Record<string, string> = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "acp-combined-"));
  cleanups.push(async () => rmSync(directory, { recursive: true, force: true }));
  const updates: acp.SessionNotification[] = [];
  const callbacks: string[] = [];
  const peers = await Promise.all(["cubic", "drafted"].map(async (name) => {
    const config = testConfig({ configFile: `${directory}/${name}.json`, acpIpcPath: `${directory}/${name}.sock` });
    config.repositories = {
      [name]: { ...config.repository, root: roots[name] ?? `/workspace/${name}`, worktreeRoot: `/worktrees/${name}` },
    };
    const sessions: acp.SessionInfo[] = [{ sessionId: `${name}-saved`, cwd: `/workspace/${name}`, title: name }];
    const calls: Array<{ method: string; params: unknown }> = [];
    const sockets = new Set<Socket>();
    const state = { failList: false, repeatCursor: false, image: false };
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      new acp.AgentSideConnection((client) => ({
        async initialize(params) {
          calls.push({ method: "initialize", params });
          return {
            protocolVersion: acp.PROTOCOL_VERSION,
            agentCapabilities: { loadSession: true, promptCapabilities: { image: state.image }, sessionCapabilities: { list: {}, resume: {}, close: {} } },
          };
        },
        async authenticate() { return {}; },
        async listSessions(params) {
          if (state.failList) throw acp.RequestError.internalError(undefined, `${name} registry unavailable`);
          const visible = sessions.filter((session) => !params.cwd || session.cwd === params.cwd);
          const start = Number(params.cursor ?? 0);
          return { sessions: visible.slice(start, start + 1), nextCursor: state.repeatCursor ? "1" : start + 1 < visible.length ? String(start + 1) : null };
        },
        async newSession(params) {
          calls.push({ method: "new", params });
          const sessionId = `${name}-new-${sessions.length}`;
          sessions.push({ sessionId, cwd: params.cwd });
          return { sessionId };
        },
        async loadSession(params) {
          calls.push({ method: "load", params });
          await client.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${name} original history` } } });
          return { _meta: { original: params.sessionId } };
        },
        async resumeSession(params) { calls.push({ method: "resume", params }); return {}; },
        async closeSession(params) { calls.push({ method: "close", params }); return {}; },
        async setSessionMode(params) { calls.push({ method: "mode", params }); return {}; },
        async setSessionConfigOption(params) { calls.push({ method: "config", params }); return { configOptions: [] }; },
        async prompt(params) {
          calls.push({ method: "prompt", params });
          const permission = await client.requestPermission({ sessionId: params.sessionId, toolCall: { toolCallId: "same-id", title: name }, options: [{ optionId: name, name, kind: "allow_once" }] });
          expect(permission.outcome).toEqual({ outcome: "selected", optionId: name });
          const file = await client.readTextFile({ sessionId: params.sessionId, path: "/example" });
          expect(file.content).toBe(params.sessionId);
          const terminal = await client.createTerminal({ sessionId: params.sessionId, command: "fixture" });
          expect((await terminal.currentOutput()).output).toBe(params.sessionId);
          await terminal.release();
          await client.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${name} response` } } });
          return { stopReason: "end_turn" };
        },
        async cancel(params) { calls.push({ method: "cancel", params }); },
      }), acp.ndJsonStream(Writable.toWeb(socket), Readable.toWeb(socket) as unknown as ReadableStream<Uint8Array>));
    });
    await new Promise<void>((resolve) => server.listen(config.acpIpcPath, resolve));
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return { name, config, sessions, calls, sockets, state };
  }));
  const input = new PassThrough();
  const output = new PassThrough();
  const run = startMultiServerBridge(peers.map((peer) => peer.config), input, output).then(() => null, (error: Error) => error);
  const client = new acp.ClientSideConnection(() => ({
    sessionUpdate(params) { updates.push(params); },
    async requestPermission(params) {
      callbacks.push(`permission:${params.sessionId}`);
      return { outcome: { outcome: "selected", optionId: params.options[0]!.optionId } };
    },
    async readTextFile(params) { return { content: params.sessionId }; },
    async createTerminal(params) { return { terminalId: params.sessionId }; },
    async terminalOutput(params) { return { output: params.sessionId, truncated: false }; },
    async releaseTerminal() { return {}; },
  }), acp.ndJsonStream(Writable.toWeb(input), Readable.toWeb(output) as unknown as ReadableStream<Uint8Array>));
  cleanups.push(async () => { input.end(); await run; input.destroy(); output.destroy(); });
  const initialize = () => client.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientInfo: { name: "test-editor", version: "1" }, clientCapabilities: { fs: { readTextFile: true }, terminal: true } });
  return { client, initialize, peers, updates, callbacks, run };
}

test("one connection lists paginated registries and loads original IDs/history regardless of cwd", async () => {
  const f = await fixture();
  f.peers[0]!.sessions.push({ sessionId: "cubic-older", cwd: "/workspace/cubic" });
  await f.initialize();
  expect((await f.client.listSessions({})).sessions.map((session) => session.sessionId)).toEqual(["cubic-older", "cubic-saved", "drafted-saved"]);
  expect((await f.client.listSessions({ cwd: "/workspace/drafted" })).sessions.map((session) => session.sessionId)).toEqual(["drafted-saved"]);
  for (const name of ["cubic", "drafted"]) {
    const loaded = await f.client.loadSession({ sessionId: `${name}-saved`, cwd: "/wrong-cwd", mcpServers: [] });
    expect(loaded._meta?.original).toBe(`${name}-saved`);
  }
  expect(f.updates.map((update) => update.sessionId)).toEqual(["cubic-saved", "drafted-saved"]);
  await expect(f.client.loadSession({ sessionId: "missing", cwd: "/workspace/drafted", mcpServers: [] })).rejects.toThrow("Unknown Remote Agent session");
  expect(f.peers.every((peer) => !peer.calls.some((call) => call.method === "new"))).toBe(true);
});

test("new sessions use the most specific checkout or worktree root and respect path boundaries", async () => {
  const f = await fixture({ cubic: "/workspace" });
  await f.initialize();
  expect((await f.client.newSession({ cwd: "/workspace/drafted/src", mcpServers: [] })).sessionId.startsWith("drafted-new-")).toBe(true);
  for (const name of ["cubic", "drafted"]) {
    const created = await f.client.newSession({ cwd: `/worktrees/${name}/feature`, mcpServers: [] });
    expect(created.sessionId.startsWith(`${name}-new-`)).toBe(true);
  }
  await expect(f.client.newSession({ cwd: "/worktrees/drafted-other", mcpServers: [] })).rejects.toThrow("No configured Remote Agent repository");
});

test("ambiguous repository roots cannot create a session", async () => {
  const f = await fixture({ cubic: "/workspace/shared", drafted: "/workspace/shared" });
  await f.initialize();
  await expect(f.client.newSession({ cwd: "/workspace/shared", mcpServers: [] })).rejects.toThrow("Multiple Remote Agent servers own");
  expect(f.peers.every((peer) => !peer.calls.some((call) => call.method === "new"))).toBe(true);
});

test("fresh connection discovers an existing owner and routes controls and concurrent callbacks", async () => {
  const f = await fixture();
  await f.initialize();
  await f.client.resumeSession({ sessionId: "drafted-saved", cwd: "/workspace/cubic", mcpServers: [] });
  await f.client.setSessionMode({ sessionId: "drafted-saved", modeId: "plan" });
  await f.client.setSessionConfigOption({ sessionId: "drafted-saved", configId: "model", value: "test-model" });
  await Promise.all(["cubic", "drafted"].map((name) => f.client.prompt({ sessionId: `${name}-saved`, prompt: [{ type: "text", text: "read only" }] })));
  await f.client.cancel({ sessionId: "drafted-saved" });
  await f.client.closeSession({ sessionId: "drafted-saved" });
  expect(f.callbacks.sort()).toEqual(["permission:cubic-saved", "permission:drafted-saved"]);
  expect(f.peers[0]!.calls.map((call) => call.method)).toEqual(["initialize", "prompt"]);
  expect(f.peers[1]!.calls.map((call) => call.method)).toEqual(["initialize", "resume", "mode", "config", "prompt", "cancel", "close"]);
  expect(f.updates.map((update) => update.sessionId).sort()).toEqual(["cubic-saved", "drafted-saved"]);
});

test("duplicate session identities and incomplete registries fail instead of selecting another server", async () => {
  const f = await fixture();
  await f.initialize();
  f.peers[1]!.sessions.push({ sessionId: "cubic-saved", cwd: "/workspace/drafted" });
  await expect(f.client.loadSession({ sessionId: "cubic-saved", cwd: "/workspace/cubic", mcpServers: [] })).rejects.toThrow("Ambiguous session");
  f.peers[1]!.sessions.pop();
  f.peers[0]!.state.failList = true;
  await expect(f.client.listSessions({})).rejects.toThrow("registry unavailable");
  f.peers[0]!.state.failList = false;
  f.peers[0]!.state.repeatCursor = true;
  await expect(f.client.listSessions({})).rejects.toThrow("repeated session list cursor");
  expect(f.peers.every((peer) => !peer.calls.some((call) => call.method === "load" || call.method === "new"))).toBe(true);
});

test("advertises shared capabilities and ends the bridge clearly on an upstream disconnect", async () => {
  const f = await fixture();
  f.peers[0]!.state.image = true;
  const initialized = await f.initialize();
  expect(initialized.agentInfo?.title).toBe("Remote Agent");
  expect(initialized.agentCapabilities?.promptCapabilities?.image).toBe(false);
  expect(initialized.agentCapabilities?.sessionCapabilities).toEqual({ list: {}, resume: {}, close: {} });
  for (const socket of f.peers[0]!.sockets) socket.destroy();
  expect((await f.run)?.message).toContain("Remote Agent disconnected");
  expect(f.peers[1]!.calls.map((call) => call.method)).toEqual(["initialize"]);
});

test("duplicate sockets and unavailable servers fail before exposing a partial connection", async () => {
  const f = await fixture();
  await f.initialize();
  await expect(startMultiServerBridge([f.peers[0]!.config, f.peers[0]!.config])).rejects.toThrow("different server socket");
  await expect(startMultiServerBridge([f.peers[0]!.config, { ...f.peers[1]!.config, acpIpcPath: "/nonexistent/acp.sock" }], new PassThrough(), new PassThrough())).rejects.toThrow("Cannot connect to Remote Agent");
});
