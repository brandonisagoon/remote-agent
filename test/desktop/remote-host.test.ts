import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import example from "../../remote-agent.config.example.json";
import { readConfigDocument, type ConfigDocument } from "../../lib/config-file.ts";
import { DesktopHostSchema, STORED_SECRET, concealHostSecrets, restoreHostSecrets } from "../../lib/desktop-host.ts";
import { desktopOperation } from "../../management/desktop-operations.ts";
import { DesktopHostManager } from "../../apps/desktop/main/hosts.ts";
import { hostCommand } from "../../apps/desktop/main/host-transport.ts";

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "remote-desktop-"));
  directories.push(directory);
  const file = path.join(directory, "remote-agent.config.json");
  writeFileSync(file, JSON.stringify(example));
  return { directory, file };
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("remote config editing preserves host credentials without returning raw JSON", async () => {
  const { file } = fixture();
  const document = await desktopOperation(file, { method: "config:get", args: [] }) as ConfigDocument;
  expect(document.valid).toBe(true);
  if (!document.valid) throw new Error("Invalid fixture");
  expect(document.raw).toBe("");
  expect(document.value.machine.server.apiKey).toBe(STORED_SECRET);
  expect(JSON.stringify(document)).not.toContain(example.connections["linear-main"].apiKey.clientSecret);
  expect(JSON.stringify(document)).not.toContain(example.connections["linear-main"].webhook.secret);
  document.value.machine.name = "Edited on remote machine";
  const saved = await desktopOperation(file, { method: "config:save", args: [{ expectedRevision: document.revision, value: document.value }] }) as ConfigDocument;
  const actual = readConfigDocument(file);
  expect(actual.valid && actual.value.machine.name).toBe("Edited on remote machine");
  expect(actual.valid && actual.value.machine.server.apiKey).toBe(example.machine.server.apiKey);
  expect(actual.valid && actual.value.connections["linear-main"]?.apiKey).toEqual({ ...example.connections["linear-main"].apiKey, type: "app" as const });
  expect(saved.raw).toBe("");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  await expect(desktopOperation(file, { method: "config:save", args: [{ expectedRevision: document.revision, value: document.value }] })).rejects.toThrow("changed on the host");
});

test("credential markers cannot be copied to another field or connection", () => {
  const current = { apiKey: "private", nested: { clientSecret: "other" } };
  expect(restoreHostSecrets(concealHostSecrets(current), current)).toEqual(current);
  expect(restoreHostSecrets({ apiKey: "replacement" }, current)).toEqual({ apiKey: "replacement" });
  expect(() => restoreHostSecrets({ name: STORED_SECRET }, current)).toThrow("Stored credential");
  expect(() => restoreHostSecrets({ newConnection: { apiKey: STORED_SECRET } }, current)).toThrow("Stored credential");
});

test("changing machine identity is rejected before a remote config write", async () => {
  const { file } = fixture();
  const current = readConfigDocument(file);
  if (!current.valid) throw new Error("Invalid fixture");
  current.value.machine.id = "different-host";
  current.value.connections["linear-main"]!.machineId = "different-host";
  await expect(desktopOperation(file, { method: "config:save", args: [{ expectedRevision: current.revision, value: current.value }] })).rejects.toThrow("identity unchanged");
  expect(readConfigDocument(file).revision).toBe(current.revision);
});

test("invalid config responses do not return parse excerpts containing secrets", async () => {
  const { file } = fixture();
  writeFileSync(file, '{"apiKey":"private-parse-canary",');
  const document = await desktopOperation(file, { method: "config:get", args: [] }) as ConfigDocument;
  expect(document.valid).toBe(false);
  expect(JSON.stringify(document)).not.toContain("private-parse-canary");
  expect(document.raw).toBe("");
});

test("repository settings write to external tooling, leaving the product unchanged", async () => {
  const { file, directory } = fixture();
  const product = path.join(directory, "product"), tooling = path.join(directory, "tooling");
  mkdirSync(product); mkdirSync(tooling);
  writeFileSync(file, JSON.stringify({ ...example, repositories: { product: { root: product, worktreeRoot: "../worktrees", tooling: { root: tooling, ref: "main" } } } }));
  await desktopOperation(file, { method: "repo-config:save", args: [{ id: "product", expectedRevision: "absent", value: { baseBranch: "staging" } }] });
  expect(existsSync(path.join(product, ".remote-agent.config.json"))).toBe(false);
  expect(JSON.parse(readFileSync(path.join(tooling, ".remote-agent.config.json"), "utf8")).baseBranch).toBe("staging");
  await expect(desktopOperation(file, { method: "repo-config:save", args: [{ id: "unknown", expectedRevision: "absent", value: {} }] })).rejects.toThrow("Unknown repository");
});

test("file picker accepts an existing file and includes dotfiles without reading contents", async () => {
  const { file, directory } = fixture();
  writeFileSync(path.join(directory, ".env"), "private-file-canary");
  const listing = await desktopOperation(file, { method: "fs:list", args: [file, "file"] }) as { path: string; entries: { name: string }[] };
  expect(listing.path).toBe(directory);
  expect(listing.entries.some((entry) => entry.name === ".env")).toBe(true);
  expect(JSON.stringify(listing)).not.toContain("private-file-canary");
});

test("remote operation allowlist rejects arbitrary commands and update installs", async () => {
  const { file } = fixture();
  await expect(desktopOperation(file, { method: "shell:exec", args: ["unexpected-command"] })).rejects.toThrow();
  await expect(desktopOperation(file, { method: "management:run", args: ["update"] })).rejects.toThrow();
});

test("supervision uses the private socket and previews reject the control API", async () => {
  const { file, directory } = fixture();
  const socket = path.join(directory, "control.sock");
  const value = structuredClone(example);
  value.machine.server.controlSocketPath = socket;
  writeFileSync(file, JSON.stringify(value));
  const previous = process.env.REMOTE_AGENT_CONFIG;
  process.env.REMOTE_AGENT_CONFIG = file;
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  let externalId = "http://127.0.0.1:9010/review";
  let unprovisioned = false;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    requests.push({ path: req.url!, method: req.method!, body: body ? JSON.parse(body) : null });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.method === "GET" ? { task: { resources: unprovisioned ? [] : [{ id: "preview", kind: "local-http", state: "ready", externalId }] } } : { resolved: true }));
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    await desktopOperation(file, { method: "tasks:resolve", args: ["task", "instruction:one", "acknowledge", "Confirmed result in the transcript"] });
    expect(requests[0]).toEqual({ path: "/api/tasks/task/instructions/instruction%3Aone/resolve", method: "POST", body: { action: "acknowledge", reason: "Confirmed result in the transcript" } });
    expect(await desktopOperation(file, { method: "tasks:preview", args: ["task", "preview"] })).toBe(externalId);
    await desktopOperation(file, { method: "tasks:control", args: ["task", "close"] });
    expect(requests.find(request => request.path === "/api/tasks/task/automation")!.body).toEqual({ action: "close" });
    for (const url of ["http://127.0.0.1:9000/api/tasks", "https://public.example/review", "http://private:token@localhost:9010/review"]) {
      externalId = url;
      await expect(desktopOperation(file, { method: "tasks:preview", args: ["task", "preview"] })).rejects.toThrow("task-owned loopback");
    }
    unprovisioned = true;
    for (const action of ["pause", "resume"]) await desktopOperation(file, { method: "tasks:control", args: ["task", action] });
    expect(requests.filter(request => request.path.endsWith("/automation")).slice(-2).map(request => request.body)).toEqual([{ action: "pause" }, { action: "resume" }]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.REMOTE_AGENT_CONFIG; else process.env.REMOTE_AGENT_CONFIG = previous;
  }
});

test("host requests address a configured owner without a global selection or profile rewrite", () => {
  const { directory } = fixture();
  const file = path.join(directory, "desktop-hosts.json");
  const profiles = { activeId: "first", hosts: [{ id: "first", name: "First", kind: "local" as const }, { id: "second", name: "Second", kind: "local" as const }] };
  writeFileSync(file, JSON.stringify(profiles));
  const manager = new DesktopHostManager(file);
  expect(manager.get("second").name).toBe("Second");
  expect(manager.get("first").name).toBe("First");
  expect(() => manager.request("unknown", "tasks:control", ["task", "close"])).toThrow("Unknown machine");
  expect(manager.list()).toEqual(profiles);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(profiles);
});

test("SSH profile rejects options and safely quotes remote paths", async () => {
  const host = { id: "air", name: "Air", kind: "ssh" as const, sshHost: "owner-air", machineId: "air", executable: "/opt/homebrew/bin/bun", runtimePath: "/home/owner/Repo '$(echo BAD)'", configPath: "/home/owner/config with spaces.json" };
  expect(DesktopHostSchema.safeParse({ ...host, sshHost: "-oProxyCommand=bad" }).success).toBe(false);
  expect(DesktopHostSchema.safeParse({ ...host, sshHost: "host\ncommand" }).success).toBe(false);
  const command = hostCommand(DesktopHostSchema.parse(host) as typeof host);
  const process = Bun.spawn(["/bin/sh", "-c", `set -- ${command}; printf '%s\\n' "$@"`]);
  const result = await new Response(process.stdout).text();
  expect(await process.exited).toBe(0);
  expect(result.split("\n")).toEqual([host.executable, `${host.runtimePath}/management/desktop-bridge.ts`, host.configPath, "air", "", ""]);
});

async function bridgeRequest(file: string, machineId: string, method: string, args: unknown[] = []) {
  const child = spawn(process.execPath, [path.resolve("management/desktop-bridge.ts"), file, machineId], { stdio: "pipe" });
  const lines = createInterface({ input: child.stdout });
  try {
    const response = new Promise<{ result?: unknown; error?: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Bridge did not respond")), 5000);
      lines.once("line", (line) => { clearTimeout(timer); try { resolve(JSON.parse(line)); } catch (error) { reject(error); } });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    child.stdin.write(JSON.stringify({ id: "test", method, args }) + "\n");
    return await response;
  } finally { lines.close(); child.stdin.end(); child.kill(); }
}

test("bridge refuses a different physical machine before performing a write", async () => {
  const { file } = fixture();
  const before = readConfigDocument(file);
  const result = await bridgeRequest(file, "wrong-host", "config:save", [{ expectedRevision: before.revision, value: example }]);
  expect(result.error).toContain("different machine identity");
  expect(readConfigDocument(file).revision).toBe(before.revision);
});

test("bridge returns a redacted config and hides invalid configuration details", async () => {
  const { file } = fixture();
  const result = await bridgeRequest(file, example.machine.id, "config:get");
  expect(result.error).toBeUndefined();
  expect(JSON.stringify(result.result)).not.toContain(example.machine.server.apiKey);
  writeFileSync(file, '{"apiKey":"bridge-private-canary",');
  const invalid = await bridgeRequest(file, example.machine.id, "config:get");
  expect(invalid.error).toContain("configuration is invalid");
  expect(JSON.stringify(invalid)).not.toContain("bridge-private-canary");
});
