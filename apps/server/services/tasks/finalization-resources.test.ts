import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertFinalizationResources, assertFinalizationTree, finalizationDigest, finalizationResourceIdentity, finalizationResourceObservation, prepareFinalizationResources, type FinalizationResourcePlan, type FinalizationResourceRecord, type ResourceObservation } from "./finalization-resources.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const quiet: ResourceObservation = { endpointAbsent: async () => {}, rootIdle: async () => {}, browserAbsent: async () => {} };
async function fixture() {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), "external-finalization-test-"))); roots.push(temp);
  const root = path.join(temp, "legacy-task-source-copies"), sourcePath = path.join(root, "source"), toolingRoot = path.join(temp, "immutable-tooling");
  await mkdir(sourcePath, { recursive: true }); await mkdir(toolingRoot);
  if (Bun.spawnSync(["git", "init", "-q", sourcePath]).exitCode) throw new Error("Test repository initialization failed");
  await writeFile(path.join(sourcePath, "readme.txt"), "accepted source");
  await writeFile(path.join(sourcePath, ".gitignore"), "node_modules/\nsecret.private\n");
  const profile = path.join(root, "browser", "profile"), ownerFile = path.join(root, "browser", "profile-owner.json");
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, "cookies.sqlite"), "private cookie bytes must never enter the source inventory");
  const marker = JSON.stringify({ taskId: "original-task", profile, nonce: randomUUID() });
  await writeFile(ownerFile, marker);
  await writeFile(path.join(root, "browser", "browser-task.json"), "private offline context");
  const capture = path.join(root, "capture.webm"), prepared = path.join(root, "prepared.mp4"), script = path.join(root, "fixture.ts");
  await writeFile(capture, "capture"); await writeFile(prepared, "prepared"); await writeFile(script, "fixture server");
  const head = "a".repeat(40), merge = "b".repeat(40);
  const deliveries = [
    { id: "publisher", repository: "example/publisher", pullRequest: 8, url: "https://github.com/example/publisher/pull/8", reviewedHead: head, mergeCommit: merge, ci: [{ runId: 123, head }] },
    { id: "policy", repository: "example/policy", pullRequest: 7, url: "https://github.com/example/policy/pull/7", reviewedHead: head, mergeCommit: merge, ci: [] },
  ];
  const row = (id: string, kind: string, externalId: string, purpose = "development", metadata: object = {}): FinalizationResourceRecord => ({ id, key: id, kind, purpose, externalId, state: "ready", expiresAt: null, metadata });
  const resources = [
    { ...row("profile", "browser-profile", profile, "browser", { namespace: "drafted", ownerFile, ownerSha256: digest(marker), session: "original-task", toolingRoot }), key: "browser-profile" },
    row("capture", "evidence", capture, "browser", { size: 7, sha256: digest("capture") }),
    row("prepared", "evidence", prepared, "browser", { size: 8, sha256: digest("prepared") }),
    row("publisher-pr", "pull-request", deliveries[0]!.url), row("policy-pr", "pull-request", deliveries[1]!.url),
    row("ci", "ci-run", "https://github.com/example/publisher/actions/runs/123"),
    row("source", "source-copies", root), row("endpoint", "local-http", "http://127.0.0.1:55022", "development", { pid: 123456, script }),
  ];
  const input = { resources, taskId: "original-task", sessionId: "original-primary", toolingRoot, sourcePaths: [sourcePath], deliveries, ownership: { sourceCopyResourceId: "source", ownedPaths: [] as string[] } };
  const prepare = (observation = quiet) => prepareFinalizationResources(input, observation);
  return { temp, root, sourcePath, toolingRoot, profile, ownerFile, capture, prepared, resources, input, prepare };
}
function tree(plan: FinalizationResourcePlan[]) {
  const result = plan.find((entry) => entry.disposition === "retire-owned" && entry.target.type === "tree");
  if (!result || result.disposition !== "retire-owned" || result.target.type !== "tree") throw new Error("Missing source tree plan");
  return result.target;
}
async function capture(plan: FinalizationResourcePlan[], renameRoot = true) {
  const target = tree(plan), source = target.inventory.find((entry) => entry.path === ".")!;
  await mkdir(target.quarantine.directory, { mode: 0o700 });
  const directory = await lstat(target.quarantine.directory);
  const journal = { version: 1, taskId: "original-task", resourceId: "source", planDigest: finalizationDigest(target), sourcePath: target.path, capturedPath: target.quarantine.path,
    source: { dev: source.dev, ino: source.ino, mode: source.mode }, quarantine: { dev: directory.dev, ino: directory.ino } };
  await writeFile(target.quarantine.journal, JSON.stringify(journal), { mode: 0o600, flag: "wx" });
  if (renameRoot) await rename(target.path, target.quarantine.path);
  return { target, journal };
}

describe("external-delivery resource ownership", () => {
  test("freezes all eight identities, retains only provider-verified references and never reads browser cookies", async () => {
    const f = await fixture(), plan = await f.prepare();
    expect(plan).toHaveLength(8);
    expect(plan.filter((entry) => entry.disposition === "retain-reference").map((entry) => entry.id).sort()).toEqual(["ci", "policy-pr", "publisher-pr"]);
    const target = tree(plan);
    expect(target.inventory.some((entry) => entry.path.endsWith("cookies.sqlite"))).toBe(false);
    expect(target.inventory.find((entry) => entry.path === "browser/profile")?.kind).toBe("opaque");
    expect(plan.at(-1)?.disposition === "retire-owned" && plan.at(-1)).toMatchObject({ dependencies: ["profile", "capture", "prepared", "endpoint"] });
    expect(JSON.stringify(plan)).not.toContain("private cookie bytes");
    await assertFinalizationResources({ taskId: "original-task", resources: f.resources, plan, removed: false }, quiet);
  });

  test("a PR or CI resource outside the independently observed delivery set is rejected", async () => {
    const f = await fixture(); f.resources.find((r) => r.id === "ci")!.externalId = "https://github.com/example/publisher/actions/runs/999";
    await expect(f.prepare()).rejects.toThrow("independently verified");
  });

  test("unknown source material requires explicit adoption instead of task-name matching", async () => {
    const f = await fixture(); await writeFile(path.join(f.root, "unexpected.txt"), "unowned");
    await expect(f.prepare()).rejects.toThrow("outside the adopted ownership");
    f.input.ownership.ownedPaths.push(path.join(f.root, "unexpected.txt"));
    expect(tree(await f.prepare()).inventory.some((entry) => entry.path === "unexpected.txt")).toBe(true);
  });

  test("ignored source files are not implicitly owned by a clean source checkout", async () => {
    const f = await fixture(); await writeFile(path.join(f.sourcePath, "secret.private"), "ignored material");
    await expect(f.prepare()).rejects.toThrow("Ignored source material");
    f.input.ownership.ownedPaths.push(path.join(f.sourcePath, "secret.private"));
    await f.prepare();
  });

  test("shared hardlinks, changed evidence and symlink ancestors block adoption", async () => {
    const f = await fixture(); await link(f.capture, path.join(f.temp, "shared-capture"));
    await expect(f.prepare()).rejects.toThrow("unshared regular file");
    await unlink(path.join(f.temp, "shared-capture"));
    await writeFile(f.capture, "otherxx");
    await expect(f.prepare()).rejects.toThrow("evidence bytes");
    await writeFile(f.capture, "capture");
    await rename(path.join(f.root, "browser"), path.join(f.temp, "moved-browser"));
    await symlink(path.join(f.temp, "moved-browser"), path.join(f.root, "browser"));
    await expect(f.prepare()).rejects.toThrow("symlink");
  });

  test("browser inspection cannot execute a resource-selected tooling checkout", async () => {
    const f = await fixture(); (f.resources[0]!.metadata as Record<string, unknown>).toolingRoot = f.sourcePath;
    await expect(f.prepare()).rejects.toThrow("original task pin");
  });

  test("unknown resource kinds and purposes fail closed", async () => {
    const f = await fixture(); f.resources.push({ id: "unknown", key: "unknown", kind: "opaque", purpose: "development", externalId: "/unknown", state: "ready" });
    await expect(f.prepare()).rejects.toThrow("unsupported resource");
    f.resources.at(-1)!.purpose = "tooling";
    await expect(f.prepare()).rejects.toThrow("Unknown resource purpose");
  });

  test("inventory preserves every dependency and refuses missing, changed or new bytes", async () => {
    const f = await fixture(), plan = await f.prepare(), target = tree(plan);
    await assertFinalizationTree(target);
    await writeFile(path.join(f.root, "new.txt"), "new material");
    await expect(assertFinalizationTree(target)).rejects.toThrow("New material");
    await unlink(path.join(f.root, "new.txt"));
    await writeFile(path.join(f.sourcePath, "readme.txt"), "different source");
    await expect(assertFinalizationTree(target)).rejects.toThrow("contents changed");
    await writeFile(path.join(f.sourcePath, "readme.txt"), "accepted source");
    await unlink(f.capture);
    await expect(assertFinalizationTree(target)).rejects.toThrow("incomplete");
  });

  test("leaf symlinks are inventoried as links without following their target", async () => {
    const f = await fixture(), outside = path.join(f.temp, "outside-secret");
    await writeFile(outside, "must survive"); await symlink(outside, path.join(f.sourcePath, "leaf-link"));
    const target = tree(await f.prepare());
    expect(target.inventory.find((entry) => entry.path === "source/leaf-link")).toMatchObject({ kind: "symlink", link: outside });
    await unlink(path.join(f.sourcePath, "leaf-link")); await symlink(f.capture, path.join(f.sourcePath, "leaf-link"));
    await expect(assertFinalizationTree(target)).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("must survive");
  });

  test("state-only release is not independent absence proof", async () => {
    const f = await fixture(), plan = await f.prepare();
    for (const resource of f.resources.filter((r) => !["pull-request", "ci-run"].includes(r.kind))) resource.state = "released";
    await expect(assertFinalizationResources({ taskId: "original-task", resources: f.resources, plan, removed: true }, quiet)).rejects.toThrow("owned filesystem resources");
    const { target } = await capture(plan);
    await assertFinalizationResources({ taskId: "original-task", resources: f.resources, plan, removed: true }, quiet);
    expect(await readFile(path.join(target.quarantine.path, "capture.webm"), "utf8")).toBe("capture");
    expect(await readFile(path.join(target.quarantine.path, "browser/profile/cookies.sqlite"), "utf8")).toContain("private cookie bytes");
    await mkdir(f.root);
    await expect(assertFinalizationResources({ taskId: "original-task", resources: f.resources, plan, removed: true }, quiet)).rejects.toThrow();
  });

  test("adoption freezes a unique sibling quarantine without creating it", async () => {
    const f = await fixture(), plan = await f.prepare(), target = tree(plan);
    expect(path.dirname(target.quarantine.directory)).toBe(path.dirname(f.root));
    expect(target.quarantine.path).toBe(path.join(target.quarantine.directory, "contents"));
    expect(target.quarantine.journal).toBe(path.join(target.quarantine.directory, "pending.json"));
    expect(await lstat(target.quarantine.directory).catch(() => null)).toBeNull();
    expect(tree(await f.prepare()).quarantine.directory).not.toBe(target.quarantine.directory);
  });

  test("pending capture and lost rename acknowledgment replay against the same frozen journal", async () => {
    const f = await fixture(), plan = await f.prepare();
    const { target } = await capture(plan, false);
    await assertFinalizationResources({ taskId: "original-task", resources: f.resources, plan, removed: false }, quiet);
    await expect(assertFinalizationResources({ taskId: "original-task", resources: f.resources, plan, removed: true }, quiet)).rejects.toThrow("active paths");
    await rename(f.root, target.quarantine.path);
    await assertFinalizationResources({ taskId: "original-task", resources: f.resources, plan, removed: false }, quiet);
    f.resources.find((resource) => resource.id === "capture")!.state = "released";
    await assertFinalizationResources({ taskId: "original-task", resources: f.resources, plan, removed: false }, quiet);
    await expect(assertFinalizationResources({ taskId: "original-task", resources: f.resources, plan, removed: true }, quiet)).rejects.toThrow("released resource receipt");
  });

  test("missing source alone and a missing or mismatched journal never prove retirement", async () => {
    const f = await fixture(), plan = await f.prepare();
    await rename(f.root, path.join(f.temp, "unrecorded-move"));
    await expect(assertFinalizationResources({ taskId: "original-task", resources: f.resources, plan, removed: false }, quiet)).rejects.toThrow("no retained quarantine proof");
    await rename(path.join(f.temp, "unrecorded-move"), f.root);
    const { target, journal } = await capture(plan);
    await expect(assertFinalizationResources({ taskId: "wrong-task", resources: f.resources, plan, removed: false }, quiet)).rejects.toThrow("journal does not match");
    for (const changed of [{ ...journal, resourceId: "other" }, { ...journal, planDigest: "0".repeat(64) }, { ...journal, quarantine: { ...journal.quarantine, ino: journal.quarantine.ino + 1 } }]) {
      await writeFile(target.quarantine.journal, JSON.stringify(changed));
      await expect(assertFinalizationResources({ taskId: "original-task", resources: f.resources, plan, removed: false }, quiet)).rejects.toThrow("journal does not match");
    }
    await unlink(target.quarantine.journal);
    await expect(assertFinalizationResources({ taskId: "original-task", resources: f.resources, plan, removed: false }, quiet)).rejects.toThrow();
    expect(await readFile(path.join(target.quarantine.path, "capture.webm"), "utf8")).toBe("capture");
  });

  test("quarantine permissions, hardlinked journals, symlinks and unexpected entries are rejected", async () => {
    const f = await fixture(), plan = await f.prepare(), { target } = await capture(plan);
    const verify = () => assertFinalizationResources({ taskId: "original-task", resources: f.resources, plan, removed: false }, quiet);
    await chmod(target.quarantine.directory, 0o755); await expect(verify()).rejects.toThrow("private directory");
    await chmod(target.quarantine.directory, 0o700); await chmod(target.quarantine.journal, 0o644); await expect(verify()).rejects.toThrow("private regular file");
    await chmod(target.quarantine.journal, 0o600); await link(target.quarantine.journal, path.join(f.temp, "shared-journal")); await expect(verify()).rejects.toThrow("private regular file");
    await unlink(path.join(f.temp, "shared-journal"));
    await writeFile(path.join(target.quarantine.directory, "unexpected"), "preserve"); await expect(verify()).rejects.toThrow("unexpected material");
    await unlink(path.join(target.quarantine.directory, "unexpected"));
    await rename(target.quarantine.directory, path.join(f.temp, "moved-quarantine"));
    await symlink(path.join(f.temp, "moved-quarantine"), target.quarantine.directory); await expect(verify()).rejects.toThrow("symlink");
  });

  test("captured replacement, changed contents and recreated active root stay preserved", async () => {
    const f = await fixture(), plan = await f.prepare(), { target } = await capture(plan);
    const verify = () => assertFinalizationResources({ taskId: "original-task", resources: f.resources, plan, removed: false }, quiet);
    await rename(target.quarantine.path, path.join(f.temp, "original-capture"));
    await mkdir(target.quarantine.path); await writeFile(path.join(target.quarantine.path, "sentinel"), "replacement survives");
    await expect(verify()).rejects.toThrow("root identity changed");
    expect(await readFile(path.join(target.quarantine.path, "sentinel"), "utf8")).toBe("replacement survives");
    await rename(target.quarantine.path, path.join(f.temp, "replacement-capture"));
    await rename(path.join(f.temp, "original-capture"), target.quarantine.path);
    await writeFile(path.join(target.quarantine.path, "capture.webm"), "changed"); await expect(verify()).rejects.toThrow("contents changed");
    await writeFile(path.join(target.quarantine.path, "capture.webm"), "capture");
    await mkdir(f.root); await writeFile(path.join(f.root, "sentinel"), "recreated survives"); await expect(verify()).rejects.toThrow("recreated");
    expect(await readFile(path.join(f.root, "sentinel"), "utf8")).toBe("recreated survives");
  });

  test("captured browser and process absence are independently required", async () => {
    const f = await fixture(), plan = await f.prepare(), { target } = await capture(plan);
    await expect(assertFinalizationResources({ taskId: "original-task", resources: f.resources, plan, removed: false }, { ...quiet, browserAbsent: async () => { throw new Error("browser running"); } })).rejects.toThrow("browser running");
    await expect(assertFinalizationResources({ taskId: "original-task", resources: f.resources, plan, removed: false }, { ...quiet, rootIdle: async (root) => { if (root === target.quarantine.path) throw new Error("captured files open"); } })).rejects.toThrow("captured files open");
    expect(await readFile(path.join(target.quarantine.path, "capture.webm"), "utf8")).toBe("capture");
  });

  test("new resources, changed metadata, or falsely released references invalidate confirmation", async () => {
    const f = await fixture(), plan = await f.prepare();
    (f.resources.find((r) => r.id === "ci")!.metadata as Record<string, unknown>).observed = "provider checked";
    await assertFinalizationResources({ taskId: "original-task", resources: f.resources, plan, removed: false }, quiet);
    f.resources.find((r) => r.id === "ci")!.state = "released";
    await expect(assertFinalizationResources({ taskId: "original-task", resources: f.resources, plan, removed: false }, quiet)).rejects.toThrow("falsely marked");
    f.resources.find((r) => r.id === "ci")!.state = "ready";
    (f.resources.find((r) => r.id === "ci")!.metadata as Record<string, unknown>).runId = 999;
    await expect(assertFinalizationResources({ taskId: "original-task", resources: f.resources, plan, removed: false }, quiet)).rejects.toThrow("identity changed");
    f.resources.push({ id: "later", key: "later", kind: "unknown", purpose: "tooling", externalId: "later", state: "ready" });
    await expect(assertFinalizationResources({ taskId: "original-task", resources: f.resources, plan, removed: false }, quiet)).rejects.toThrow("set changed");
  });

  test("endpoint and open-process uncertainty fail before any cleanup authority", async () => {
    const f = await fixture();
    await expect(f.prepare({ ...quiet, rootIdle: async () => { throw new Error("still open"); } })).rejects.toThrow("still open");
    await expect(f.prepare({ ...quiet, endpointAbsent: async () => { throw new Error("PID reused"); } })).rejects.toThrow("PID reused");
    expect(await readFile(f.capture, "utf8")).toBe("capture");
  });

  test("resource identity ignores observation timestamps but not ownership or expiration", async () => {
    const f = await fixture(), resource = f.resources[1]!, first = finalizationResourceIdentity(resource);
    resource.metadata = { ...(resource.metadata as object), observed: "removed", observedAt: new Date().toISOString() }; resource.state = "released";
    expect(finalizationResourceIdentity(resource)).toEqual(first);
    resource.expiresAt = new Date().toISOString();
    expect(finalizationResourceIdentity(resource).identityDigest).not.toBe(first.identityDigest);
  });

  test("browser absence checks the drafted namespace rather than a quiet default namespace", async () => {
    const f = await fixture(), bin = path.join(f.toolingRoot, "node_modules", ".bin"); await mkdir(bin, { recursive: true });
    const executable = path.join(bin, "agent-browser");
    await writeFile(executable, '#!/usr/bin/env bun\nconsole.log(JSON.stringify({ success: true, data: { sessions: process.env.AGENT_BROWSER_NAMESPACE === "drafted" ? ["original-task"] : [] } }));\n', { mode: 0o700 });
    await expect(finalizationResourceObservation.browserAbsent({ session: "original-task", toolingRoot: f.toolingRoot })).rejects.toThrow("still running");
  });
});
