import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { testConfig } from "../../test-support/config.ts";
import { controlDevelopmentCompute } from "../../management/development-control.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(action: "pause" | "resume", change: "none" | "bytes" | "intent" = "none") {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "development-desktop-"))); roots.push(root);
  const config = testConfig({ installRoot: path.join(root, "install"), controlIpcPath: path.join(root, "control.sock") });
  const temporary = path.join(root, "capability"), marker = path.join(root, "executed.json"), saved = path.join(root, "intent.json"); mkdirSync(temporary);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: temporary, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init"); git("config", "user.email", "fixture@example.com"); git("config", "user.name", "Fixture");
  writeFileSync(path.join(temporary, "cli.ts"), `await Bun.write(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify({taskId:'task',developmentIntent:JSON.parse(await Bun.file(${JSON.stringify(saved)}).text())}));`);
  git("add", "."); git("commit", "-m", "Exact runtime fixture"); const revision = git("rev-parse", "HEAD");
  const checkout = path.join(config.installRoot, "tooling", config.repository.id, revision); mkdirSync(path.dirname(checkout), { recursive: true }); renameSync(temporary, checkout);
  config.repository.tooling = { root: checkout, revision }; config.repositories = { ...config.repositories, [config.repository.id]: config.repository };
  const adapter = path.join(checkout, "cli.ts");
  let intent: any, requestKey = "", reads = 0; const requests: any[] = [];
  const task = () => ({ id: "task", primarySessionId: "primary", repositoryId: config.repository.id, worktreePath: "/original", toolingRevision: "a".repeat(40), developmentIntent: intent });
  const server = Bun.serve({ unix: config.controlIpcPath, async fetch(request) {
    const url = new URL(request.url), body = request.method === "POST" ? await request.json() as any : undefined; requests.push({ path: url.pathname, body });
    if (url.pathname.endsWith("/automation")) {
      requestKey = body.requestKey; intent = { version: 1, revision: 17, digest: "b".repeat(64), requestKey, action: action === "pause" ? "stop" : "resume", reason: action === "pause" ? "owner-pause" : "owner-resume", state: "pending" };
      writeFileSync(saved, JSON.stringify(intent)); return Response.json({ task: task(), ...(action === "pause" ? { pause: { state: "pending", pendingSessionIds: ["primary"] } } : {}) }, { status: 202 });
    }
    if (url.pathname.endsWith("/tooling-capability")) {
      if (change === "bytes") writeFileSync(adapter, "throw new Error('Mutable adapter must never execute')");
      return Response.json({ receipt: { contract: "remote-agent.tooling-capability/v1", capability: "runtime", source: "configured-host", taskToolingRevision: "a".repeat(40), capabilityRevision: revision, checkout, adapter, instructions: adapter } });
    }
    if (change === "intent" && !reads++) intent = { ...intent, revision: 18, digest: "c".repeat(64) };
    return Response.json({ task: task() });
  } });
  return { config, marker, requests, server, key: () => requestKey };
}

for (const action of ["pause", "resume"] as const) test(`desktop ${action} immediately invokes the immutable runtime CLI with the same durable key`, async () => {
  const f = await fixture(action);
  try {
    const result = await controlDevelopmentCompute(f.config, "task", action);
    expect(JSON.parse(readFileSync(f.marker, "utf8"))).toEqual(["upkeep", action, "--socket", f.config.controlIpcPath, "--task", "task", "--request-key", f.key()]);
    expect(f.requests[0].body).toEqual({ action, development: true, requestKey: f.key() });
    expect(f.requests[1].body).toEqual({ capability: "runtime", development: { intentRevision: 17, intentDigest: "b".repeat(64) } });
    expect(result.task.developmentIntent.requestKey).toBe(f.key()); expect(result.development.developmentIntent.state).toBe("pending");
    expect(f.requests.some(item => item.path.includes("instructions"))).toBeFalse();
  } finally { f.server.stop(true); }
});
for (const change of ["bytes", "intent"] as const) test(`desktop refuses ${change} drift before executing any runtime command`, async () => {
  const f = await fixture("pause", change);
  try { await expect(controlDevelopmentCompute(f.config, "task", "pause")).rejects.toThrow("changed"); expect(existsSync(f.marker)).toBeFalse(); }
  finally { f.server.stop(true); }
});

test("the local Electron context selects the installed Bun executable for the actual child", async () => {
  const f = await fixture("pause"), descriptor = Object.getOwnPropertyDescriptor(process, "execPath")!;
  try {
    Object.defineProperty(process, "execPath", { ...descriptor, value: "/fixture/Remote Agent.app/Contents/MacOS/Electron" });
    await controlDevelopmentCompute(f.config, "task", "pause");
    expect(JSON.parse(readFileSync(f.marker, "utf8"))[0]).toBe("upkeep");
  } finally { Object.defineProperty(process, "execPath", descriptor); f.server.stop(true); }
});
