import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testConfig } from "../../../../test-support/config.ts";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { beginRuntimeSession } from "../sessions/runtime-registry.ts";
import { beginTask } from "./store.ts";
import { prepareTaskPrompt } from "./preparation.ts";
import { resolveToolingCompatibility } from "./tooling-compatibility.ts";
import { resolveSessionToolingCapability } from "./tooling-capabilities.ts";
import { recordDevelopmentIntent } from "./development-intent.ts";
import { createApp } from "../../app.ts";
import { deliverManagedMerge } from "../../workers/product/workflow/merge-delivery.ts";
import { CompletionContractInput, setCompletionContract, type OwnerMergeApproval } from "./completion.ts";
import { deliverInstructions } from "../sessions/inbox.ts";
import type { WorkflowConfig } from "../../../../lib/config.ts";
import type { WorkerContext } from "../../../../types/dispatcher/index.ts";
import type { SourceIssueWithAgentIssues } from "../../integrations/linear/session-store/source-issue/types.ts";

let directory: string;
let db: TestDatabase;
beforeEach(async () => { directory = mkdtempSync(path.join(tmpdir(), "tooling-compatibility-")); db = await createTestDatabase(); });
afterEach(async () => { await db.cleanup(); rmSync(directory, { recursive: true }); });
function git(cwd: string, ...args: string[]) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function write(root: string, relative: string, text: string) { mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); writeFileSync(path.join(root, relative), text); }
function commit(root: string) { git(root, "add", "."); git(root, "commit", "-m", "fixture"); return git(root, "rev-parse", "HEAD"); }
const workflow: WorkflowConfig = { id: "merge", on: "issue.state-changed", when: [{ "issue.state": ["Merge"] }], connectionId: null, deliver: "message-session", providerId: "codex", model: null, plan: null, skill: { skillset: "merge", flags: [] } };

async function fixture(pinnedPreparation = false) {
  const source = path.join(directory, "source"); mkdirSync(source);
  git(source, "init"); git(source, "config", "user.name", "Fixture"); git(source, "config", "user.email", "fixture@example.com");
  write(source, "AGENTS.md", "Pinned owner authorizes isolated headless verification.");
  if (pinnedPreparation) write(source, "agent-skills/prepare/instructions.md", "Prepare with the pinned constituent instructions and verify real readiness.");
  const oldRevision = commit(source);
  write(source, ".remote-agent-capabilities.json", JSON.stringify({ version: 1, capabilities: {
    prepare: { instructions: "agent-skills/prepare/instructions.md", adapter: "src/cli.ts" },
    merge: { instructions: "agent-skills/merge/instructions.md", adapter: "src/cli.ts" },
    cleanup: { instructions: "agent-skills/merge/instructions.md", adapter: "src/cli.ts" },
    runtime: { instructions: "projects/runtime.md", adapter: "src/cli.ts" },
    browser: { instructions: "projects/browser.md", adapter: "src/cli.ts" },
    "development-credentials": { instructions: "credentials/README.md", adapter: "src/credentials-backup.ts" },
  } }));
  write(source, "agent-skills/prepare/instructions.md", "Host preparation capability: inspect the actual task services.");
  write(source, "agent-skills/merge/instructions.md", "Host merge capability: finish authorized commit, push, PR and cleanup; recheck Merge authority.");
  write(source, "src/cli.ts", "// committed adapter fixture");
  write(source, "projects/runtime.md", "Reviewed remote runtime: reuse the exact recorded database and saved data.");
  write(source, "projects/browser.md", "Reviewed headless browser: reuse the task-owned profile and verify the actual app.");
  write(source, "credentials/README.md", "Approved development recovery: inspect field names, verify integrity, export only task-required keys. Never use production fallback. Decryption is not provider validation.");
  write(source, "src/credentials-backup.ts", "throw new Error('Capability resolution must not execute this adapter');");
  const hostRevision = commit(source);
  const config = testConfig({ installRoot: path.join(directory, "install") });
  const repository = { ...config.repository, root: path.join(directory, "product"), tooling: { root: source, revision: oldRevision } };
  mkdirSync(repository.root);
  const task = await beginTask(db.prisma, { requestKey: "task", repository, machineId: config.machine, connectionId: config.activeConnectionId, issueIdentifier: "DRA-21", branchName: "codex/dra21" });
  const pin = (revision: string) => {
    const target = path.join(config.installRoot, "tooling", repository.id, revision);
    mkdirSync(path.dirname(target), { recursive: true }); git(source, "worktree", "add", "--detach", target, revision);
    writeFileSync(`${target}.ready`, `${revision}\n`); return target;
  };
  const oldPin = pin(oldRevision), hostPin = pin(hostRevision);
  const session = await beginRuntimeSession(db.prisma, { sessionKey: "primary", agent: "codex", cwd: repository.root, role: "primary", repositoryId: repository.id, machineId: config.machine,
    resourceLinks: [{ provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-21", relationship: "handles" }] });
  await db.prisma.runtimeSession.update({ where: { id: session.id }, data: { status: "active" } });
  const currentTask = await db.prisma.remoteTask.update({ where: { id: task.id }, data: { primarySessionId: session.id, worktreePath: repository.root, pinnedToolingRoot: oldPin, phase: "review" } });
  repository.tooling.revision = hostRevision;
  config.repository = repository; config.repositories = { [repository.id]: repository };
  const runtime = createFakeAgentRuntime([{ ...session, status: "active" }]);
  let state = "Merge";
  const read = async () => ({ id: "issue", identifier: "DRA-21", title: "Task", description: "Accepted scope", state: { name: state }, labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } } as unknown as SourceIssueWithAgentIssues);
  const context: WorkerContext = { prisma: db.prisma, config, agentRuntime: runtime, runId: "run", commandClient: {
    run: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "" }),
  } };
  let approval: Promise<OwnerMergeApproval> | undefined;
  const recordApproval = () => approval ??= setCompletionContract({ prisma: db.prisma, config, taskId: task.id,
    contract: CompletionContractInput.parse({ requestKey: "merge-test", expectedRevision: 0, boundary: "merge", basis: "Owner fixture accepted Merge", repository: "owner/product", baseBranch: "main" }),
  }).then((saved) => ({ requestKey: saved.contract.requestKey, contractRevision: saved.revision }));
  const revokeCompletion = async () => {
    const saved = await recordApproval();
    return setCompletionContract({ prisma: db.prisma, config, taskId: task.id, contract: CompletionContractInput.parse({
      requestKey: "owner-revoked", expectedRevision: saved.contractRevision, boundary: "revoked", basis: "Owner withdrew merge authority while source remains Merge",
    }) });
  };
  const merge = (overrides: Partial<Parameters<typeof deliverManagedMerge>[0]> = {}) => deliverManagedMerge({ context, workflow, issueIdentifier: "DRA-21",
    webhook: { type: "Issue", action: "update", webhookTimestamp: 123, actor: { id: "owner" }, data: { id: "issue", identifier: "DRA-21", state: { name: "Merge", type: "started" } }, updatedFrom: { stateId: "review" } },
    seed: "Use {{SKILL:merge}} for the existing accepted task.", read, recordApproval, compose: async () => { throw new Error("Unknown skillset merge at old pin"); }, ...overrides });
  return { config, repository, task: currentTask, session, source, oldPin, hostPin, oldRevision, hostRevision, merge, runtime, revoke: () => { state = "Manual Review"; }, revokeCompletion, pin };
}

test("missing composed preparation uses committed pinned constituents and retains owner policy", async () => {
  const f = await fixture(true);
  const prepared = await prepareTaskPrompt({ prisma: db.prisma, task: f.task, repository: f.repository, installRoot: f.config.installRoot, worktreePath: f.repository.root, provider: "claude", seed: "Use {{SKILL:prepare}}. Preserve the owner request.", compose: async () => { throw new Error("drafted-prepare-all absent"); } });
  expect(prepared.prompt).toContain("pinned constituent instructions");
  expect(prepared.prompt).toContain("Pinned owner authorizes isolated headless verification");
  expect(prepared.prompt).toContain("Preserve the owner request");
  expect(prepared.prompt).toContain("resolve_tooling_capability");
  expect(prepared.prompt).not.toContain("{{SKILL:");
  const task = await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } });
  expect(task).toMatchObject({ toolingRevision: f.oldRevision, pinnedToolingRoot: f.oldPin, phase: "preparing", environmentStatus: "degraded" });
  expect(JSON.parse(task.recoveryDetail!).compatibility).toMatchObject({ source: "pinned-constituents", capabilityRevision: f.oldRevision });
});

test("host preparation capability is versioned and does not borrow mutable source edits", async () => {
  const f = await fixture();
  write(f.source, "agent-skills/prepare/instructions.md", "MUTABLE UNCOMMITTED POLICY");
  const recovered = await resolveToolingCompatibility({ task: f.task, repository: f.repository, installRoot: f.config.installRoot, capability: "prepare", worktreePath: f.repository.root, seed: "Original request", pinnedToolingRoot: f.oldPin });
  expect(recovered.prompt).toContain("Host preparation capability");
  expect(recovered.prompt).not.toContain("MUTABLE UNCOMMITTED POLICY");
  expect(recovered.receipt).toMatchObject({ contract: "remote-agent.tooling-capability/v1", source: "configured-host", capabilityRevision: f.hostRevision, taskToolingRevision: f.oldRevision, adapter: realpathSync(path.join(f.hostPin, "src/cli.ts")) });
  expect(git(f.oldPin, "rev-parse", "HEAD")).toBe(f.oldRevision);
});

test("old pin resolves development credentials with durable provenance, no adapter effects and unchanged pins", async () => {
  const f = await fixture();
  write(f.source, "credentials/README.md", "UNCOMMITTED SOURCE MUST NOT ENTER CAPABILITY");
  write(f.source, "src/credentials-backup.ts", "UNCOMMITTED ADAPTER");
  const input = { prisma: db.prisma, config: f.config, sessionId: f.session.id, capability: "development-credentials" as const };
  const first = await resolveSessionToolingCapability(input);
  const again = await resolveSessionToolingCapability(input);
  expect(again).toEqual(first);
  expect(first.receipt).toMatchObject({ source: "configured-host", capabilityRevision: f.hostRevision, taskToolingRevision: f.oldRevision,
    adapter: realpathSync(path.join(f.hostPin, "src/credentials-backup.ts")) });
  expect(first.instructions).toContain("Approved development recovery");
  expect(first.instructions).toContain("invalid credentials and provider outage");
  expect(first.instructions).toContain("Never use production fallback");
  expect(first.instructions).not.toContain("UNCOMMITTED");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "tooling-capability" } })).toBe(1);
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
  expect(await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).toMatchObject({ toolingRevision: f.oldRevision, pinnedToolingRoot: f.oldPin, primarySessionId: f.session.id });
  expect(existsSync(path.join(f.oldPin, "src/credentials-backup.ts"))).toBeFalse();
});

test("credential capability route rejects arbitrary names and paths and uses task-bound identity", async () => {
  const f = await fixture();
  const app = createApp({ config: f.config, prisma: db.prisma, agentRuntime: f.runtime });
  const request = (body: unknown, sessionId = f.session.id) => app.request(`/api/sessions/${sessionId}/tooling-capability`, {
    method: "POST", headers: { authorization: `Bearer ${f.config.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  for (const body of [{ capability: "merge" }, { capability: "production-credentials" }, { capability: "development-credentials", adapter: "/tmp/arbitrary.ts" }]) {
    expect((await request(body)).status).toBe(400);
  }
  expect((await request({ capability: "development-credentials" }, "another-session")).status).toBe(409);
  expect((await request({ capability: "development-credentials" })).status).toBe(200);
});

for (const capability of ["runtime", "browser"] as const) {
  test(`existing task resolves ${capability} from committed host tooling without repinning or starting work`, async () => {
    const f = await fixture(true);
    write(f.source, `projects/${capability}.md`, "UNCOMMITTED MUST NOT EXECUTE");
    const result = await resolveSessionToolingCapability({ prisma: db.prisma, config: f.config, sessionId: f.session.id, capability });
    expect(result.receipt).toMatchObject({ capability, source: "configured-host", capabilityRevision: f.hostRevision, taskToolingRevision: f.oldRevision,
      adapter: realpathSync(path.join(f.hostPin, "src/cli.ts")) });
    expect(result.instructions).toContain(capability === "runtime" ? "exact recorded database" : "task-owned profile");
    expect(result.instructions).not.toContain("UNCOMMITTED");
    expect(await db.prisma.runtimeInstruction.count()).toBe(0);
    expect(await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).toMatchObject({ primarySessionId: f.session.id, toolingRevision: f.oldRevision, pinnedToolingRoot: f.oldPin });
    await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
    await expect(resolveSessionToolingCapability({ prisma: db.prisma, config: f.config, sessionId: f.session.id, capability })).rejects.toThrow("paused");
  });
}

test("paused runtime resolution requires the exact development intent and cannot resolve another capability or a superseded request", async () => {
  const f = await fixture(true), context = { prisma: db.prisma, config: f.config, taskId: f.task.id };
  const development = await recordDevelopmentIntent({ ...context, request: { action: "pause", development: true, requestKey: "desktop-pause" } });
  const input = { prisma: db.prisma, config: f.config, sessionId: f.session.id, capability: "runtime" as const, development };
  expect((await resolveSessionToolingCapability(input)).receipt.capability).toBe("runtime");
  await expect(resolveSessionToolingCapability({ ...input, capability: "browser" } as any)).rejects.toThrow();
  await expect(resolveSessionToolingCapability({ ...input, development: { ...development, intentDigest: "0".repeat(64) } })).rejects.toThrow("changed");
  await recordDevelopmentIntent({ ...context, request: { action: "resume", development: true, requestKey: "new-owner-resume" } });
  await expect(resolveSessionToolingCapability(input)).rejects.toThrow("changed");
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
});

test("old pin resolves named cleanup without running effects, changing authority or repinning", async () => {
  const f = await fixture();
  const input = { prisma: db.prisma, config: f.config, sessionId: f.session.id, capability: "cleanup" as const };
  const result = await resolveSessionToolingCapability(input);
  expect(result.receipt).toMatchObject({ capability: "cleanup", capabilityRevision: f.hostRevision, taskToolingRevision: f.oldRevision });
  expect(result.instructions).toContain("not new deletion or merge authority");
  expect(result.instructions).toContain("independently verified absence");
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "completion-contract" } })).toBe(0);
  expect(await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).toMatchObject({ primarySessionId: f.session.id, toolingRevision: f.oldRevision, pinnedToolingRoot: f.oldPin });
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "closed" } });
  await expect(resolveSessionToolingCapability(input)).rejects.toThrow("closed");
});

test("undeclared development credential capability fails concretely without upgrading the task", async () => {
  const f = await fixture();
  write(f.source, ".remote-agent-capabilities.json", JSON.stringify({ version: 1, capabilities: {} }));
  const revision = commit(f.source); f.repository.tooling.revision = revision; f.pin(revision);
  await expect(resolveSessionToolingCapability({ prisma: db.prisma, config: f.config, sessionId: f.session.id, capability: "development-credentials" })).rejects.toThrow("does not supply capability development-credentials");
  expect(await db.prisma.runtimeMetadataEvent.count()).toBe(0);
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).toolingRevision).toBe(f.oldRevision);
});

test("closure and source ownership revocation block resolution before preparing a host checkout", async () => {
  const f = await fixture();
  const input = { prisma: db.prisma, config: f.config, sessionId: f.session.id, capability: "development-credentials" as const };
  let invoked = false;
  const resolve: typeof resolveToolingCompatibility = async () => { invoked = true; throw new Error("must not run"); };
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "closed" } });
  await expect(resolveSessionToolingCapability(input, resolve)).rejects.toThrow("closed");
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "working" } });
  await db.prisma.runtimeSessionResourceLink.updateMany({ where: { runtimeSessionId: f.session.id }, data: { endedAt: new Date() } });
  await expect(resolveSessionToolingCapability(input, resolve)).rejects.toThrow("revoked");
  expect(invoked).toBeFalse();
  expect(await db.prisma.runtimeMetadataEvent.count()).toBe(0);
});

test("worktree identity change during capability preparation prevents returning or recording authority", async () => {
  const f = await fixture();
  await expect(resolveSessionToolingCapability({ prisma: db.prisma, config: f.config, sessionId: f.session.id, capability: "development-credentials" }, async (input) => {
    const resolved = await resolveToolingCompatibility(input);
    // A changed worktree cannot receive authority prepared for the old one.
    await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { worktreePath: "/changed-worktree" } });
    return resolved;
  })).rejects.toThrow("owning task primary");
  expect(await db.prisma.runtimeMetadataEvent.count()).toBe(0);
});

test("old-pin Merge creates one durable continuation and provenance without a preexisting PR", async () => {
  const f = await fixture();
  const results = await Promise.all([f.merge(), f.merge()]);
  expect(results.every((result) => result.status === "delivered" || result.status === "existing")).toBeTrue();
  expect(await db.prisma.runtimeInstruction.count()).toBe(1);
  const instruction = await db.prisma.runtimeInstruction.findFirstOrThrow();
  expect(instruction).toMatchObject({ sessionId: f.session.id, state: "queued" });
  expect(instruction.text).toContain("finish authorized commit, push, PR");
  expect(instruction.text).toContain(f.hostRevision);
  expect(instruction.text).not.toContain("{{SKILL:");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "workflow-dispatch" } })).toBe(1);
  expect(await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).toMatchObject({ toolingRevision: f.oldRevision, pinnedToolingRoot: f.oldPin, primarySessionId: f.session.id });
  expect(f.runtime.sentMessages).toHaveLength(0);
  await db.prisma.$disconnect();
  expect((await f.merge()).status).toBe("existing");
  expect(await db.prisma.runtimeInstruction.count()).toBe(1);
});

test("closure and revoked authority block compatibility and retries before dispatch", async () => {
  const f = await fixture();
  let compositions = 0;
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "closed" } });
  expect((await f.merge({ compose: async () => { compositions++; return "unused"; } })).detail).toContain("existing task primary");
  expect(compositions).toBe(0);
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "working" } });
  await f.merge();
  f.revoke();
  expect((await f.merge()).detail).toContain("revoked");
  expect(await db.prisma.runtimeInstruction.count()).toBe(1);
});

test("authority changing during composition cannot enqueue a merge", async () => {
  const f = await fixture();
  expect((await f.merge({ compose: async () => { f.revoke(); return "composed"; } })).detail).toContain("revoked");
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "workflow-dispatch" } })).toBe(0);
});

test("completion revocation during composition prevents enqueue even when source remains Merge", async () => {
  const f = await fixture();
  const result = await f.merge({ compose: async () => { await f.revokeCompletion(); return "composed"; } });
  expect(result.detail).toContain("Completion authority was revoked or replaced");
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
});

test("completion revocation cancels a queued merge before provider dispatch", async () => {
  const f = await fixture();
  expect((await f.merge()).status).toBe("delivered");
  await f.revokeCompletion();
  f.runtime.putSession({ ...f.session, status: "idle" });
  await deliverInstructions(db.prisma, f.runtime);
  expect(f.runtime.sentMessages).toHaveLength(0);
  expect(await db.prisma.runtimeInstruction.findFirstOrThrow()).toMatchObject({ state: "cancelled", detail: "Owner merge authority was revoked, replaced or is unverified; this instruction will not replay." });
});

test("completion revocation during a capacity wait prevents the atomic instruction claim", async () => {
  const f = await fixture();
  expect((await f.merge()).status).toBe("delivered");
  let claim: (() => Promise<boolean>) | undefined;
  let finish!: () => void;
  f.runtime.startTurn = (input) => ({
    requestId: input.requestId!, events: { async *[Symbol.asyncIterator]() {} }, cancel: async () => {},
    result: new Promise<{ status: "cancelled" }>((resolve) => { claim = input.beforeStart; finish = () => resolve({ status: "cancelled" }); }),
  });
  f.runtime.putSession({ ...f.session, status: "idle" });
  // Merge starts a background delivery pass. Wait until that pass (or this
  // one) reaches the runtime's capacity wait before withdrawing authority.
  for (let attempt = 0; attempt < 100 && !claim; attempt++) {
    await deliverInstructions(db.prisma, f.runtime);
    await Bun.sleep(5);
  }
  expect(claim).toBeDefined();
  try {
    await f.revokeCompletion();
    expect(await claim!()).toBe(false);
  } finally { finish(); }
  expect((await db.prisma.runtimeInstruction.findFirstOrThrow()).state).toBe("cancelled");
});

test("approval validation fails before composition or host capability effects", async () => {
  const f = await fixture();
  let composed = false;
  const result = await f.merge({ recordApproval: async () => { throw new Error("No authenticated owner workflow receipt"); }, compose: async () => { composed = true; return "unexpected"; } });
  expect(result.detail).toContain("No authenticated owner workflow receipt");
  expect(composed).toBeFalse();
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
});

test("closed preparation cannot install or select a compatibility capability", async () => {
  const f = await fixture(true);
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "closed" } });
  let composed = false;
  await expect(prepareTaskPrompt({ prisma: db.prisma, task: f.task, repository: f.repository, installRoot: f.config.installRoot, worktreePath: f.repository.root,
    provider: "codex", seed: "Prepare", compose: async () => { composed = true; throw new Error("missing"); } })).rejects.toThrow("closed");
  expect(composed).toBeFalse();
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).recoveryDetail).toBeNull();
});

test("unavailable host compatibility reports a concrete failure rather than repinning", async () => {
  const f = await fixture();
  f.repository.tooling.revision = f.oldRevision;
  const result = await f.merge();
  expect(result).toMatchObject({ status: "failed" });
  expect(result.detail).toContain("does not declare a versioned merge compatibility capability");
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).toolingRevision).toBe(f.oldRevision);
});

test("capability paths cannot escape the committed checkout through symlinks", async () => {
  const f = await fixture();
  const outside = path.join(directory, "outside.ts"); writeFileSync(outside, "not authorized");
  rmSync(path.join(f.source, "src/cli.ts")); symlinkSync(outside, path.join(f.source, "src/cli.ts"));
  const revision = commit(f.source); f.repository.tooling.revision = revision; f.pin(revision);
  const result = await f.merge();
  expect(result.status).toBe("failed");
  expect(result.detail).toContain("escapes its checkout");
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
  expect(existsSync(outside)).toBeTrue();
});
