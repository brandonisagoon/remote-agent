import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { testConfig } from "../../../../test-support/config.ts";
import { provisionWorktree } from "./provision-worktree.ts";
import { resolveWorktreeCommonDirectory } from "./worktree-base.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "remote-agent-registration-")); directories.push(directory);
  const root = path.join(directory, "repository"); mkdirSync(root);
  git(root, "init", "-qb", "main");
  writeFileSync(path.join(root, "tracked"), "original"); git(root, "add", ".");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "initial");
  const head = git(root, "rev-parse", "HEAD");
  return { directory, head, repository: { ...testConfig().repository, root, worktreeRoot: path.join(directory, "worktrees"), preparation: "agent" as const, baseBranch: head } };
}
function rendezvous(directory: string) {
  const state = path.join(directory, "started"); mkdirSync(state);
  const program = path.join(directory, "rendezvous.ts");
  writeFileSync(program, `#!${process.execPath}\nimport { writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
const state = ${JSON.stringify(state)};
writeFileSync(path.join(state, path.basename(process.cwd())), "started");
const deadline = Date.now() + 3000;
while (readdirSync(state).length < 2) {
  if (Date.now() > deadline) throw new Error("Independent phase was serialized");
  await Bun.sleep(10);
}
`, { mode: 0o755 });
  return program;
}

test("parallel registrations from linked checkouts share the common Git directory without changing source work", async () => {
  const f = fixture(), linked = path.join(f.directory, "linked"), alias = path.join(f.directory, "alias");
  git(f.repository.root, "worktree", "add", "--detach", linked, f.head);
  symlinkSync(f.repository.root, alias, "dir");
  expect(await resolveWorktreeCommonDirectory(linked)).toBe(await resolveWorktreeCommonDirectory(f.repository.root));
  expect(await resolveWorktreeCommonDirectory(alias)).toBe(await resolveWorktreeCommonDirectory(f.repository.root));
  writeFileSync(path.join(f.repository.root, "tracked"), "owner edits");
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => provisionWorktree({
    repository: { ...f.repository, root: [f.repository.root, linked, alias][index % 3]! }, branchName: `parallel/${index}`,
  })));
  expect(results.filter(result => result.status === "rejected")).toEqual([]);
  for (const result of results) if (result.status === "fulfilled") expect(git(result.value, "rev-parse", "HEAD")).toBe(f.head);
  expect(git(f.repository.root, "rev-parse", "HEAD")).toBe(f.head);
  expect(readFileSync(path.join(f.repository.root, "tracked"), "utf8")).toBe("owner edits");
  expect(git(linked, "rev-parse", "HEAD")).toBe(f.head);
});

test("one refused registration does not poison queued or later worktree creation", async () => {
  const f = fixture(); git(f.repository.root, "branch", "existing");
  const [refused, queued] = await Promise.allSettled([
    provisionWorktree({ repository: f.repository, branchName: "existing" }),
    provisionWorktree({ repository: f.repository, branchName: "queued" }),
  ]);
  expect(refused.status).toBe("rejected"); expect(queued.status).toBe("fulfilled");
  const later = await provisionWorktree({ repository: f.repository, branchName: "later" });
  expect(git(later, "rev-parse", "HEAD")).toBe(f.head);
  expect(git(f.repository.root, "rev-parse", "existing")).toBe(f.head);
});

test("repository bootstrap remains concurrent after each registration completes", async () => {
  const f = fixture(), program = rendezvous(f.directory);
  const repository = { ...f.repository, preparation: "command" as const, bootstrapCommand: [process.execPath, "--no-env-file", program] };
  const results = await Promise.allSettled(["bootstrap-a", "bootstrap-b"].map(branchName => provisionWorktree({ repository, branchName })));
  expect(results.filter(result => result.status === "rejected")).toEqual([]);
});

test("independent repositories can register while each other's Git command remains in flight", async () => {
  const one = fixture(), two = fixture(), program = rendezvous(one.directory);
  const hooks = path.join(one.directory, "hooks"); mkdirSync(hooks);
  writeFileSync(path.join(hooks, "post-checkout"), readFileSync(program), { mode: 0o755 });
  for (const f of [one, two]) git(f.repository.root, "config", "core.hooksPath", hooks);
  const results = await Promise.allSettled([
    provisionWorktree({ repository: one.repository, branchName: "independent-a" }),
    provisionWorktree({ repository: two.repository, branchName: "independent-b" }),
  ]);
  expect(results.filter(result => result.status === "rejected")).toEqual([]);
});
