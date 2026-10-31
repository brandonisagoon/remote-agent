import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, appendFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createTestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import { refreshComputeBaselines } from "./compute-baseline.ts";
import { requestCompute, offerNextCompute, confirmComputeDelivery, claimCompute } from "./compute-admission.ts";

const source = process.env.DRAFTED_INTEGRATION_ROOT;
const enabled = process.env.DRAFTED_BASELINE_DOCKER_TEST === "1" && Boolean(source);
const image = "sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4";
// Real disposable Docker + committed installed CLI + SQLite admission. No
// configured task, shared network, provider account or installed pilot state.
test.skipIf(!enabled)("original unbound group is physically reconciled before normal offer/delivery/claim", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "compute-baseline-pair-"))), db = await createTestDatabase();
  const ids: string[] = [], nonce = `baseline-${crypto.randomUUID()}`;
  const command = async (args: string[]) => {
    const child = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(`Disposable command failed: ${args[0]} ${args[1]}: ${error.slice(0, 500)}`);
    return out.trim();
  };
  try {
    const revision = await command(["git", "-C", source!, "rev-parse", "HEAD"]), checkout = path.join(root, "tooling", "repo", revision);
    await mkdir(path.dirname(checkout), { recursive: true });
    await command(["git", "clone", "--shared", "--quiet", source!, checkout]); await command(["git", "-C", checkout, "checkout", "--quiet", revision]);
    await symlink(path.join(source!, "node_modules"), path.join(checkout, "node_modules"));
    await appendFile(path.join(checkout, ".git", "info", "exclude"), "\n/node_modules\n");
    const prisma = db.prisma, runtime = createFakeAgentRuntime(); runtime.observeSessionActivity = () => ({ state: "unknown", observedAt: Date.now() });
    const base = testConfig({ machine: nonce, compute: ComputePolicy.parse({ enabled: true, slots: 1, collectorFreshnessSeconds: 30 }) });
    const config = { ...base, installRoot: root, repositories: { repo: { ...base.repository, id: "repo", tooling: { repository: "https://example.invalid/tooling.git", revision } } } } as unknown as typeof base;
    for (const id of [nonce, `${nonce}-waiting`]) {
      await prisma.runtimeSession.create({ data: { id, scopeKey: id, agentCommand: "codex", repositoryId: "repo", machineId: nonce, role: "primary", cwd: path.join(root, id), status: id === nonce ? "closed" : "idle", ...(id === nonce ? { closedAt: new Date() } : {}) } });
      await prisma.remoteTask.create({ data: { id, requestKey: id, repositoryId: "repo", machineId: nonce, branchName: `codex/${id}`, worktreePath: path.join(root, id), toolingRoot: "/original/pin", toolingRevision: "a".repeat(40), primarySessionId: id, phase: id === nonce ? "closed" : "working", ownerPaused: id === nonce } });
    }
    const create = async (key: string) => {
      const id = await command(["docker", "create", "--network", "none", "--name", `${nonce}-${key}`, "--label", `dev.drafted.task=${nonce}`, "--label", "dev.drafted.purpose=development", image, "sleep", "infinity"]);
      ids.push(id); const [actual] = JSON.parse(await command(["docker", "container", "inspect", id])); return actual;
    };
    for (const key of ["app", "data"]) {
      const actual = await create(key);
      await prisma.remoteTaskResource.create({ data: { taskId: nonce, key, kind: "docker-container", purpose: "development", state: "ready", externalId: actual.Id, metadata: { image: actual.Image, createdAt: actual.Created } } });
    }
    const context = { prisma, config, runtime }, admission = { ...context, machineId: nonce, policy: config.compute! };
    const request = { key: "new", purpose: "development" as const, revision: "b".repeat(40), recipeDigest: "c".repeat(64) };
    await requestCompute({ ...admission, taskId: `${nonce}-waiting`, request });
    expect(await refreshComputeBaselines(context)).toEqual({ observed: 1, unavailable: 0 });
    const extra = await create("unregistered");
    expect(await offerNextCompute(admission)).toBeNull();
    await command(["docker", "rm", extra.Id]);
    const first = await offerNextCompute(admission); expect(first).not.toBeNull();
    // Registry release alone cannot hide a restarted physical member.
    await prisma.remoteTaskResource.updateMany({ where: { taskId: nonce }, data: { state: "released" } });
    await command(["docker", "start", ids[0]!]);
    const deliver = async (offer: NonNullable<typeof first>) => {
      await prisma.runtimeInstruction.update({ where: { id: offer.instructionId }, data: { state: "dispatching", executionRequestId: offer.instructionId } });
      await prisma.runtimeLifecycleEvent.create({ data: { id: crypto.randomUUID(), runtimeSessionId: `${nonce}-waiting`, requestId: offer.instructionId, phase: "started", occurredAt: new Date() } });
      return confirmComputeDelivery({ ...admission, sessionId: `${nonce}-waiting`, requestId: offer.instructionId });
    };
    expect(await deliver(first!)).toBeNull(); expect(await prisma.computeSlot.count({ where: { allocationId: { not: null } } })).toBe(0);
    await command(["docker", "stop", "--time", "1", ids[0]!]);
    await prisma.runtimeInstruction.update({ where: { id: first!.instructionId }, data: { state: "completed" } });
    await prisma.runtimeLifecycleEvent.create({ data: { id: crypto.randomUUID(), runtimeSessionId: `${nonce}-waiting`, requestId: first!.instructionId, phase: "completed", occurredAt: new Date() } });
    const before = await prisma.remoteTaskResource.findMany({ where: { taskId: nonce }, orderBy: { id: "asc" } });
    const final = await offerNextCompute(admission); expect(final).not.toBeNull(); expect((await deliver(final!))?.state).toBe("offered");
    expect((await claimCompute({ ...admission, taskId: `${nonce}-waiting`, offerId: final!.id, request })).offer.state).toBe("claimed");
    expect(await prisma.remoteTaskResource.findMany({ where: { taskId: nonce }, orderBy: { id: "asc" } })).toEqual(before);
    expect(await prisma.computeEnvironment.count({ where: { taskId: nonce } })).toBe(0);
    expect(await prisma.remoteTask.findUnique({ where: { id: nonce } })).toMatchObject({ phase: "closed", ownerPaused: true, toolingRevision: "a".repeat(40) });
    expect(await prisma.runtimeMetadataEvent.count()).toBe(0);
    const actual = JSON.parse(await command(["docker", "container", "inspect", ...ids.slice(0, 2)]));
    expect(actual.map((value: any) => [value.Id, value.State.Running])).toEqual(ids.slice(0, 2).map(id => [id, false]));
  } finally {
    for (const id of ids) {
      const inspected = Bun.spawnSync(["docker", "container", "inspect", id]);
      if (inspected.exitCode === 0 && JSON.parse(inspected.stdout.toString())[0]?.Config?.Labels?.["dev.drafted.task"] === nonce) await command(["docker", "rm", "-f", id]);
    }
    await db.cleanup(); await rm(root, { recursive: true, force: true });
  }
}, 120_000);
