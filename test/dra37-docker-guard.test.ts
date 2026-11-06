/** Portable guard tests (no real Docker). The policy's docker is a STUB
 * script: it records the exact argv it receives and answers from stub.json.
 * Refusals must exit 125 without the stub ever being reached; accepted calls
 * prove the exact forwarded argv, name/alias rewriting and the durable ledger. */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readEngineSubnets, selectFixtureSubnet } from "./dra37-subnet.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const IMAGE = `sha256:${"e".repeat(64)}`, NETWORK = "a".repeat(64), PREFIX = "dra37fx-test";
const DRAFTED_APP = "drafted-d-000000000000000000000000-app";
const STUB = `const { appendFileSync, readFileSync } = require("node:fs");
const directory = require("node:path").dirname(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(directory + "/stub-calls.jsonl", JSON.stringify(args) + "\\n");
const stub = JSON.parse(readFileSync(directory + "/stub.json", "utf8"));
const [command, sub] = args;
if (command === "image" && sub === "inspect") console.log(JSON.stringify(stub.imageConfig ?? { Env: [] }));
else if (command === "network" && sub === "ls") console.log(Object.keys(stub.networks ?? {}).join("\\n"));
else if (command === "network" && sub === "inspect") for (const id of args.slice(4)) console.log(JSON.stringify(id) + "\\t" + JSON.stringify((stub.networks ?? {})[id] ?? null));
else if (command === "network" && sub === "create") console.log(stub.networkId);
else if (command === "volume" && sub === "create") console.log(stub.volumeOutput ?? args.at(-1));
else if (command === "create") console.log(stub.createOutput);
else if (command === "container" && sub === "ls") console.log(stub.listing ?? "");
else { console.error("stub: unmodelled " + args.join(" ")); process.exit(3); }
`;

function fixture(stub: Record<string, unknown> = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "dra37-guard-")));
  roots.push(root);
  const policy = path.join(root, "policy.json"), ledger = path.join(root, "ledger.jsonl"), docker = path.join(root, "stub-docker.js");
  const worktree = path.join(root, "worktrees", "first"), runtimeState = path.join(root, "state", "runtimes", "dra37-first", "development", "app");
  mkdirSync(worktree, { recursive: true }); mkdirSync(runtimeState, { recursive: true });
  writeFileSync(docker, `#!${process.execPath} --no-env-file\n${STUB}`, { mode: 0o700 });
  writeFileSync(path.join(root, "stub.json"), JSON.stringify({ networks: { ["9".repeat(64)]: [{ Subnet: "10.249.0.0/28" }] }, createOutput: "c".repeat(64), networkId: "b".repeat(64), ...stub }));
  writeFileSync(policy, JSON.stringify({ root, prefix: PREFIX, docker, images: [IMAGE], ledger, log: path.join(root, "calls.jsonl") }));
  writeFileSync(ledger, [{ kind: "network", id: NETWORK, name: `${PREFIX}-${DRAFTED_APP}` },
    { kind: "volume", id: `${PREFIX}-drafted-d-000000000000000000000000-dependencies`, name: `${PREFIX}-drafted-d-000000000000000000000000-dependencies` },
    { kind: "container", id: "d".repeat(64), name: `${PREFIX}-drafted-d-000000000000000000000000-proxy`, published: [55001] }]
    .map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const read = (file: string) => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const guard = (...args: string[]) => {
    const before = read(path.join(root, "stub-calls.jsonl")).length;
    const result = Bun.spawnSync([process.execPath, "--no-env-file", path.join(import.meta.dir, "dra37-docker-guard.ts"), policy, ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString(), calls: read(path.join(root, "calls.jsonl")) as Array<Record<string, unknown>>,
      stubCalls: (read(path.join(root, "stub-calls.jsonl")) as string[][]).slice(before) };
  };
  const create = (...extra: string[]) => guard("create", "--name", DRAFTED_APP, "--network", NETWORK, "--label", "dev.drafted.task=dra37-first",
    "--mount", `type=bind,source=${worktree},target=/workspace`, ...extra, IMAGE, "bun");
  return { root, worktree, runtimeState, guard, create, ledger: () => read(ledger) as Array<Record<string, unknown>>, setStub: (value: Record<string, unknown>) => writeFileSync(path.join(root, "stub.json"), JSON.stringify(value)) };
}

test("the guard refuses everything outside the fixture policy before reaching Docker", () => {
  const { guard, create, root, worktree } = fixture();
  const refused = (result: { code: number | null; stderr: string; stubCalls: unknown[] }, reason: RegExp) => {
    expect(result.code).toBe(125); expect(result.stderr).toMatch(reason); expect(result.stubCalls).toEqual([]);
  };
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
  // Mounts: Docker-faithful fields, private subtrees only, canonical sources.
  refused(create("--mount", "type=bind,source=/usr,target=/x"), /outside the private worktrees\/ and state\/runtimes\/ subtrees/);
  for (const forbidden of [root, path.join(root, "policy.json"), path.join(root, "ledger.jsonl"), path.join(root, "worktrees")]) refused(create("--mount", `type=bind,source=${forbidden},target=/x`), /outside the private worktrees/);
  refused(create("--mount", `type=bind,source=${worktree}/../first,target=/x`), /absolute normalized path/);
  refused(create("--mount", `type=bind,source=${worktree}/,target=/x`), /absolute normalized path/);
  symlinkSync("/etc", path.join(worktree, "escape"));
  refused(create("--mount", `type=bind,source=${worktree}/escape,target=/x`), /not canonical/);
  refused(create("--mount", `type=bind,source=${worktree},source=/etc,target=/x`), /duplicate mount option source/);
  refused(create("--mount", `type=bind,src=${worktree},target=/x`), /mount option "src" is not allowed/);
  refused(create("--mount", `type=bind,source=${worktree},target=/x,bind-propagation=shared`), /mount option "bind-propagation" is not allowed/);
  refused(create("--mount", `type=bind,"source=${worktree}",target=/x`), /quoted mount fields/);
  refused(create("--mount", `type=bind,source=,target=/x`), /empty value/);
  refused(create("--mount", `type=bind,source=${worktree},target=/x,readonly=yes`), /readonly value/);
  refused(create("--mount", `type=bind,source=${worktree},target=relative`), /absolute normalized container path/);
  refused(create("--mount", `type=bind,source=${worktree},target=/workspace`), /duplicate mount targets/);
  refused(create("--mount", "type=volume,source=unrecorded,target=/x"), /not an already-ledgered fixture volume/);
  refused(create("--mount", `type=volume,source=${PREFIX}-x/y,target=/x`), /volume source .* is malformed/);
  refused(create("--mount", `type=tmpfs,target=/x`), /mount type tmpfs/);
  refused(guard("create", "--name", "other", "--network", NETWORK, "--label", "dev.drafted.task=dra37-first", IMAGE), /fixture-prefixed --name/);
  refused(guard("create", "--name", DRAFTED_APP, "--network", "b".repeat(64), "--label", "dev.drafted.task=dra37-first", IMAGE), /ledger --network/);
  refused(guard("create", "--name", DRAFTED_APP, "--network", NETWORK, "--label", "dev.drafted.task=dra37-first", "nginx:latest"), /recorded immutable fixture image/);
  refused(guard("stop", "--time", "5", "c".repeat(64)), /stop of non-fixture container/);
  refused(guard("rm", "-f", "c".repeat(64)), /option -f is not allowed/);
  refused(guard("exec", "-i", "c".repeat(64), "sh"), /exec into non-fixture container/);
  refused(guard("network", "create", "--label", "dev.drafted.task=dra37-first", "--subnet", "10.0.0.0/8", "drafted-d-111111111111111111111111-app"), /callers may not choose a subnet/);
  refused(guard("volume", "rm", "anything"), /unmodelled command volume rm/);
  refused(guard("system", "prune", "-f"), /unmodelled command system prune/);
}, 60_000);

test("accepted creates forward the exact rewritten argv and durably ledger the exact ID before output", () => {
  const { create, guard, ledger, setStub, worktree, runtimeState } = fixture();
  // Internal app: no publication; Docker-faithful mount values (first "=" split,
  // so a source containing "=" is checked and forwarded whole).
  const equalsDirectory = path.join(worktree, "a=b");
  mkdirSync(equalsDirectory);
  const internal = create("--mount", `type=bind,source=${equalsDirectory},target=/data,readonly`,
    "--mount", `type=bind,source=${runtimeState},target=/run/drafted,readonly=true`,
    "--mount", `type=volume,source=${PREFIX}-drafted-d-000000000000000000000000-dependencies,target=/workspace/node_modules`);
  expect(internal.code, internal.stderr).toBe(0);
  expect(internal.stdout.trim()).toBe("c".repeat(64));
  expect(internal.stubCalls.map(args => args.slice(0, 2))).toEqual([["image", "inspect"], ["create", "--name"]]);
  const forwarded = internal.stubCalls[1]!;
  expect(forwarded.slice(0, 4)).toEqual(["create", "--name", `${PREFIX}-${DRAFTED_APP}`, "--network-alias"]);
  expect(forwarded[4]).toBe(DRAFTED_APP);
  expect(forwarded).toContain(`type=bind,source=${equalsDirectory},target=/data,readonly`);
  expect(forwarded.some(value => value === "--publish")).toBe(false);
  expect(ledger().at(-1)).toMatchObject({ kind: "container", id: "c".repeat(64), name: `${PREFIX}-${DRAFTED_APP}` });
  expect(ledger().at(-1)!.published).toBeUndefined();

  // Proxy: one explicit loopback ephemeral port, recorded with its owner.
  setStub({ createOutput: "f".repeat(64) });
  const proxy = guard("create", "--name", "drafted-d-000000000000000000000000-proxy2", "--network", NETWORK, "--label", "dev.drafted.task=dra37-first", "--publish", "127.0.0.1:55010:8080", IMAGE);
  expect(proxy.code, proxy.stderr).toBe(0);
  expect(proxy.stubCalls[1]!.filter(value => value === "--publish")).toHaveLength(1);
  expect(ledger().at(-1)).toMatchObject({ kind: "container", id: "f".repeat(64), published: [55010] });

  // Outbound names are un-prefixed for Drafted.
  setStub({ listing: `${PREFIX}-${DRAFTED_APP}\nunrelated` });
  expect(guard("container", "ls", "-a", "--format", "{{.Names}}").stdout).toBe(`${DRAFTED_APP}\nunrelated\n`);

  // Network create: guard-assigned non-overlapping subnet, exact ID ledgered.
  setStub({ networks: { ["9".repeat(64)]: [{ Subnet: "10.249.0.0/28" }] }, networkId: "b".repeat(64) });
  const network = guard("network", "create", "--label", "dev.drafted.task=dra37-first", "drafted-d-111111111111111111111111-app");
  expect(network.code, network.stderr).toBe(0);
  expect(network.stubCalls.at(-1)).toEqual(["network", "create", "--label", "dev.drafted.task=dra37-first", "--subnet", "10.249.0.16/28", `${PREFIX}-drafted-d-111111111111111111111111-app`]);
  expect(ledger().at(-1)).toMatchObject({ kind: "network", id: "b".repeat(64), name: `${PREFIX}-drafted-d-111111111111111111111111-app` });

  // Volume create: the output must be exactly the requested name.
  const volume = guard("volume", "create", "--label", "dev.drafted.task=dra37-first", "drafted-d-111111111111111111111111-dependencies");
  expect(volume.code, volume.stderr).toBe(0);
  expect(ledger().at(-1)).toMatchObject({ kind: "volume", id: `${PREFIX}-drafted-d-111111111111111111111111-dependencies` });
}, 60_000);

test("malformed create output and implicit image volumes fail closed without ledgering", () => {
  const { create, guard, ledger, setStub } = fixture({ createOutput: "Created container (not an id)" });
  const before = ledger().length;
  const malformed = create();
  expect(malformed.code).toBe(125);
  expect(malformed.stderr).toMatch(/not the exact expected ID/);
  expect(malformed.stdout).toBe("");
  expect(malformed.calls.some(call => call.unrecognizedCreateOutput === "Created container (not an id)")).toBe(true);
  setStub({ volumeOutput: "some-other-volume" });
  expect(guard("volume", "create", "--label", "dev.drafted.task=dra37-first", "drafted-d-222222222222222222222222-dependencies").stderr).toMatch(/not the exact expected ID/);
  expect(ledger()).toHaveLength(before);

  // The immutable image declares a volume: refused unless an owned mount covers it.
  setStub({ imageConfig: { Volumes: { "/data": {} } }, createOutput: "c".repeat(64) });
  const anonymous = create();
  expect(anonymous.code).toBe(125);
  expect(anonymous.stderr).toMatch(/untracked anonymous volume\(s\) \/data/);
  expect(anonymous.stubCalls.map(args => args[0])).toEqual(["image"]);
  setStub({ imageConfig: "not json-object" });
  expect(create().stderr).toMatch(/image config .* is malformed/);
  setStub({ imageConfig: { Volumes: { "/data": {} } }, createOutput: "c".repeat(64) });
  const covered = create("--mount", `type=volume,source=${PREFIX}-drafted-d-000000000000000000000000-dependencies,target=/data`);
  expect(covered.code, covered.stderr).toBe(0);
  expect(ledger()).toHaveLength(before + 1);
}, 60_000);

test("fixture subnet selection uses true IPv4 CIDR overlap and fails closed on inventory", () => {
  // Overlap is numeric, not textual: wider or offset prefixes block candidates.
  expect(selectFixtureSubnet([])).toBe("10.249.0.0/28");
  expect(selectFixtureSubnet(["10.0.0.0/8"])).toBeNull();
  expect(selectFixtureSubnet(["10.248.0.0/15"])).toBeNull();
  expect(selectFixtureSubnet(["10.249.0.0/17"])).toBe("10.249.128.0/28");
  expect(selectFixtureSubnet(["10.249.0.0/28", "10.249.0.16/29"])).toBe("10.249.0.32/28");
  expect(selectFixtureSubnet(["10.249.0.5/30"])).toBe("10.249.0.16/28");
  expect(selectFixtureSubnet(["192.168.0.0/16", "fd00:dead:beef::/48", "172.16.0.0/12"])).toBe("10.249.0.0/28");
  expect(selectFixtureSubnet(["0.0.0.0/0"])).toBeNull();
  for (const malformed of ["10.249.0.0/33", "10.249.0.256/28", "10.249.0/24", "10.249.0.0", "fd00::/129", "x"]) expect(() => selectFixtureSubnet([malformed])).toThrow(/Malformed/);

  const id = (digit: string) => digit.repeat(64);
  const engine = (listing: { code: number; stdout: string }, inspection: { code: number; stdout: string }) =>
    (args: string[]) => args[1] === "ls" ? { ...listing, stderr: "list failure" } : { ...inspection, stderr: "inspect failure" };
  const line = (network: string, config: unknown) => `${JSON.stringify(network)}\t${JSON.stringify(config)}`;
  const listed = { code: 0, stdout: `${id("a")}\n${id("b")}\n` };
  expect(readEngineSubnets(engine(listed, { code: 0, stdout: [line(id("a"), [{ Subnet: "10.0.0.0/8", Gateway: "10.0.0.1" }]), line(id("b"), null)].join("\n") }))).toEqual(["10.0.0.0/8"]);
  const refused = (listing: { code: number; stdout: string }, inspection: { code: number; stdout: string }, reason: RegExp) => expect(() => readEngineSubnets(engine(listing, inspection))).toThrow(reason);
  refused({ code: 1, stdout: "" }, { code: 0, stdout: "" }, /network ls failed/);
  refused({ code: 0, stdout: "" }, { code: 0, stdout: "" }, /no networks/);
  refused({ code: 0, stdout: "abc\n" }, { code: 0, stdout: "" }, /malformed ID/);
  refused(listed, { code: 1, stdout: "" }, /network inspect failed/);
  refused(listed, { code: 0, stdout: line(id("a"), null) }, /described 1 of 2/);
  refused(listed, { code: 0, stdout: [line(id("a"), null), line(id("c"), null)].join("\n") }, /Unexpected network inspect ID/);
  refused(listed, { code: 0, stdout: [line(id("a"), null), `${JSON.stringify(id("b"))} not-json`].join("\n") }, /Malformed network inspect line/);
  refused(listed, { code: 0, stdout: [line(id("a"), [{ Subnet: "10.249.0.0/40" }]), line(id("b"), null)].join("\n") }, /Malformed IPv4 subnet/);
  refused(listed, { code: 0, stdout: [line(id("a"), { Subnet: "10.0.0.0/8" }), line(id("b"), null)].join("\n") }, /Malformed IPAM config/);
});
