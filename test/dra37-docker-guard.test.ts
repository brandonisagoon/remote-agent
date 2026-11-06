/** Portable: guard refusals happen before any Docker CLI is reached (the
 * policy's docker binary does not exist, so anything that slipped through
 * would fail differently from the guard's refusal code 125). */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
    { kind: "volume", id: "dra37fx-test-drafted-d-000000000000000000000000-dependencies", name: "dra37fx-test-drafted-d-000000000000000000000000-dependencies" },
    { kind: "container", id: "d".repeat(64), name: "dra37fx-test-drafted-d-000000000000000000000000-proxy", published: [55001] }]
    .map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const guard = (...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, "--no-env-file", path.join(import.meta.dir, "dra37-docker-guard.ts"), policy, ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, stderr: result.stderr.toString(), calls: readFileSync(path.join(root, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) };
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
  refused(create("--publish", "0.0.0.0:55000:8080"), /explicit 127\.0\.0\.1/);
  refused(create("--publish", "127.0.0.1::8080"), /explicit 127\.0\.0\.1/);
  refused(create("--publish", "8080"), /explicit 127\.0\.0\.1/);
  refused(create("--publish", "127.0.0.1:8080:8080"), /outside the OS ephemeral range/);
  refused(create("--publish", "127.0.0.1:55001:8080"), /already owned by a fixture container/);
  refused(create("--publish", "127.0.0.1:55002:8080", "--publish", "127.0.0.1:55002:8081"), /already owned by a fixture container/);
  refused(create("-p", "127.0.0.1:55003:8080"), /option -p is not allowed/);
  refused(create("--publish-all"), /option --publish-all is not allowed/);
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

test("publication is optional: internal and loopback-ephemeral creates pass the policy unchanged", () => {
  const { create } = fixture();
  // Passing the policy means the guard forwards to Docker (absent here), so
  // the call is logged as forwarded and fails as a spawn error, not code 125.
  const forwarded = (result: { code: number | null; stderr: string; calls: Array<{ args?: string[]; refused?: string }> }) => {
    expect(result.calls.some(call => call.refused)).toBe(false);
    return result.calls.filter(call => call.args).at(-1)!.args!;
  };
  const internal = forwarded(create());
  expect(internal.some(value => value === "--publish" || value.startsWith("--publish="))).toBe(false);
  expect(internal.slice(internal.indexOf("--network-alias"), internal.indexOf("--network-alias") + 2)).toEqual(["--network-alias", "drafted-d-000000000000000000000000-app"]);
  const proxy = forwarded(create("--publish", "127.0.0.1:55010:8080"));
  expect(proxy.filter(value => value === "--publish")).toHaveLength(1);
  expect(proxy[proxy.indexOf("--publish") + 1]).toBe("127.0.0.1:55010:8080");
});
