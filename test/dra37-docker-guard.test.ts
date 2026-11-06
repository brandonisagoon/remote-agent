/** Portable: guard refusals happen before any Docker CLI is reached (the
 * policy's docker binary does not exist, so anything that slipped through
 * would fail differently from the guard's refusal code 125). */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const IMAGE = `sha256:${"e".repeat(64)}`, NETWORK = "a".repeat(64);

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "dra37-guard-")));
  roots.push(root);
  const policy = path.join(root, "policy.json"), ledger = path.join(root, "ledger.jsonl");
  writeFileSync(policy, JSON.stringify({ root, prefix: "dra37fx-test", docker: path.join(root, "no-docker"), images: [IMAGE], ledger, log: path.join(root, "calls.jsonl") }));
  writeFileSync(ledger, [{ kind: "network", id: NETWORK, name: "dra37fx-test-drafted-d-000000000000000000000000-app" },
    { kind: "volume", id: "dra37fx-test-drafted-d-000000000000000000000000-dependencies", name: "dra37fx-test-drafted-d-000000000000000000000000-dependencies" }]
    .map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const guard = (...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, "--no-env-file", path.join(import.meta.dir, "dra37-docker-guard.ts"), policy, ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, stderr: result.stderr.toString() };
  };
  const create = (...extra: string[]) => guard("create", "--name", "drafted-d-000000000000000000000000-app", "--network", NETWORK, "--label", "dev.drafted.task=dra37-first",
    "--mount", `type=bind,source=${root},target=/workspace`, ...extra, IMAGE, "bun");
  return { root, guard, create };
}

test("the guard refuses everything outside the fixture policy before reaching Docker", () => {
  const { guard, create, root } = fixture();
  const refused = (result: { code: number | null; stderr: string }, reason: RegExp) => { expect(result.code).toBe(125); expect(result.stderr).toMatch(reason); };
  refused(create("--privileged"), /--privileged is not allowed/);
  refused(create("--pull=always"), /only --pull=never/);
  refused(create("--publish", "0.0.0.0:8080:8080"), /not a loopback ephemeral port/);
  refused(create("--mount", "type=bind,source=/etc,target=/x"), /resolves outside the fixture root/);
  refused(create("--mount", "type=volume,source=unrecorded,target=/x"), /not an already-ledgered fixture volume/);
  refused(create("--mount", `type=tmpfs,source=${root},target=/x`), /mount type tmpfs/);
  refused(guard("create", "--name", "other", "--network", NETWORK, "--label", "dev.drafted.task=dra37-first", IMAGE), /fixture-prefixed --name/);
  refused(guard("create", "--name", "drafted-d-000000000000000000000000-app", "--network", "b".repeat(64), "--label", "dev.drafted.task=dra37-first", IMAGE), /ledger --network/);
  refused(guard("create", "--name", "drafted-d-000000000000000000000000-app", "--network", NETWORK, "--label", "dev.drafted.task=dra37-first", "nginx:latest"), /recorded immutable fixture image/);
  refused(guard("stop", "--time", "5", "c".repeat(64)), /stop of non-fixture container/);
  refused(guard("rm", "-f", "c".repeat(64)), /option -f is not allowed/);
  refused(guard("exec", "-i", "c".repeat(64), "sh"), /exec into non-fixture container/);
  refused(guard("network", "create", "--label", "dev.drafted.task=dra37-first", "--subnet", "10.0.0.0/8", "drafted-d-111111111111111111111111-app"), /callers may not choose a subnet/);
  refused(guard("volume", "rm", "anything"), /unmodelled command volume rm/);
  refused(guard("system", "prune", "-f"), /unmodelled command system prune/);
});
