/**
 * DRA-37 REAL-Docker policy guard: the only `docker` the fixture's server,
 * agent and adapter processes can reach. It forwards to the real Docker CLI
 * after enforcing the disposable-fixture policy, so Drafted's actual
 * transports run unchanged against real containers.
 *
 * - Drafted resource names (`drafted-[dr]-<24 hex>…`) get this fixture's
 *   unique prefix on the way in and are restored on the way out; created
 *   containers keep the original name only as a network alias on their
 *   private fixture network (Drafted's NGINX reaches the app by name).
 * - Every command is parsed with an exact option grammar (allowlist). Any
 *   unknown option, command or target is refused.
 * - create: unique prefixed --name, a ledger --network, only recorded image
 *   IDs in image position, only --pull=never. --mount is split like Docker
 *   (comma fields, first "="), with only type/source/target/readonly, no
 *   duplicates and no quoting. A bind source must be exactly canonical and
 *   inside worktrees/ or state/runtimes/ of the private fixture root (never
 *   the root, config, sockets, policy or ledger); a volume source must be an
 *   already-ledgered fixture volume. The image's declared Config.Volumes must
 *   all be covered by owned mounts, so Docker never creates an untracked
 *   anonymous volume (read-only image inspect; nothing is pulled or changed).
 * - Publication is optional and never added: internal app containers stay
 *   unpublished on their private ledger network. A container that does
 *   publish (Drafted's proxy) must name an explicit 127.0.0.1 host port
 *   inside the OS ephemeral range that no other ledger container owns; the
 *   port is recorded with the container in the ledger.
 * - Every destructive/exec target must be a ledger object.
 * - Every created object (ID and name) is durably appended (fsync) to the
 *   ledger BEFORE its ID is written to the caller.
 * - Fixture networks get an explicit /28 in 10.249.0.0/16 whose numeric CIDR
 *   interval overlaps no subnet of any engine network (dra37-subnet.ts; a
 *   failed or malformed read-only inventory refuses the create). The shared
 *   engine's default pools can be exhausted; nothing is ever cleared or
 *   pruned and engine configuration is never changed.
 *
 * Usage (via the generated bin/docker shim): docker-guard <policy.json> <args...>
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { readEngineSubnets, selectFixtureSubnet } from "./dra37-subnet.ts";

type Policy = { root: string; prefix: string; docker: string; images: string[]; ledger: string; log: string };
const policy = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Policy;
const root = realpathSync(policy.root);
const raw = process.argv.slice(3);
const log = (entry: object) => appendFileSync(policy.log, JSON.stringify({ at: Date.now(), ...entry }) + "\n");
function refuse(reason: string): never { log({ refused: reason, args: raw }); console.error(`dra37 docker guard refused: ${reason}`); process.exit(125); }

const NAME = /(?<![A-Za-z0-9_.-])(drafted-[dr]-[0-9a-f]{24}[a-z0-9-]*)/g;
const inbound = (value: string) => value.replace(NAME, `${policy.prefix}-$1`);
const outbound = (text: string) => text.split(`${policy.prefix}-drafted-`).join("drafted-");
type Entry = { kind: "container" | "network" | "volume"; id: string; name: string; published?: number[] };
const ledger = (): Entry[] => existsSync(policy.ledger) ? readFileSync(policy.ledger, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const owned = (value: string, kinds: Entry["kind"][]) => ledger().some(entry => kinds.includes(entry.kind) && (entry.id === value || entry.name === value || (/^[a-f0-9]{12,}$/.test(value) && entry.id.startsWith(value))));
function record(entry: Entry) {
  const descriptor = openSync(policy.ledger, "a", 0o600);
  try { writeSync(descriptor, JSON.stringify({ ...entry, at: new Date().toISOString() }) + "\n"); fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

/** Exact option grammar: value options take `--x v` or `--x=v`; flags take none. */
function parse(tokens: string[], values: string[], flags: string[], stopAtPositional: boolean) {
  const options: [string, string | true][] = [], positionals: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (stopAtPositional && positionals.length) { positionals.push(token); continue; }
    if (!token.startsWith("-") || token === "-") { positionals.push(token); continue; }
    const [name, inline] = token.includes("=") ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)] : [token, undefined];
    if (values.includes(name)) { const value = inline ?? tokens[++index]; if (value === undefined) refuse(`option ${name} needs a value`); options.push([name, value]); }
    else if (flags.includes(name) && inline === undefined) options.push([name, true]);
    else refuse(`option ${token} is not allowed`);
  }
  return { options, positionals };
}

/** Private bind subtrees only: never the fixture root, config, sockets,
 * policy or ledger. */
const BIND_ROOTS = [`${root}/worktrees`, `${root}/state/runtimes`];
type Mount = { type: "bind" | "volume"; source: string; target: string; readonly: boolean };
/** Docker splits --mount into comma fields and each field at its FIRST "=".
 * Quoted CSV fields are refused rather than re-implemented. */
function parseMount(value: string): Mount {
  if (value.includes('"') || value.includes("'")) refuse("quoted mount fields are not allowed");
  const fields = new Map<string, string | true>();
  for (const field of value.split(",")) {
    const at = field.indexOf("=");
    const key = at < 0 ? field : field.slice(0, at), fieldValue = at < 0 ? true : field.slice(at + 1);
    if (!["type", "source", "target", "readonly"].includes(key)) refuse(`mount option ${JSON.stringify(key)} is not allowed`);
    if (fields.has(key)) refuse(`duplicate mount option ${key}`);
    if (fieldValue === "") refuse(`mount option ${key} has an empty value`);
    fields.set(key, fieldValue);
  }
  const type = fields.get("type"), source = fields.get("source"), target = fields.get("target"), readonly = fields.get("readonly") ?? "false";
  if (type !== "bind" && type !== "volume") refuse(`mount type ${String(type)} is not allowed`);
  if (typeof source !== "string" || typeof target !== "string") refuse("mounts need an explicit source and target");
  if (!target.startsWith("/") || target.split("/").some(part => part === ".." || part === ".")) refuse(`mount target ${target} must be an absolute normalized container path`);
  if (type === "bind" && (!source.startsWith("/") || source.split("/").slice(1).some(part => part === "" || part === "." || part === ".."))) refuse(`bind source ${source} must be an absolute normalized path`);
  if (type === "volume" && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(source)) refuse(`volume source ${source} is malformed`);
  if (readonly !== true && !["true", "false", "1", "0"].includes(readonly as string)) refuse(`mount readonly value ${String(readonly)} is malformed`);
  return { type, source, target, readonly: readonly === true || readonly === "true" || readonly === "1" };
}

let args = raw.map(inbound);
const [command, sub] = args;
const isContainerVerb = command === "container" && ["inspect", "start", "stop", "kill", "rm", "logs", "wait"].includes(sub ?? "");
const verb = isContainerVerb ? sub! : command!;
const rest = args.slice(isContainerVerb ? 2 : 1);
let created: Entry["kind"] | null = null, createdName = "", createdPublished: number[] = [];
/** The OS ephemeral port range (macOS sysctl, Linux procfs); unknown means refuse. */
function ephemeralRange(): [number, number] {
  if (process.platform === "darwin") {
    const read = (key: string) => Number(Bun.spawnSync(["/usr/sbin/sysctl", "-n", key], { stdout: "pipe" }).stdout.toString().trim());
    return [read("net.inet.ip.portrange.first"), read("net.inet.ip.portrange.last")];
  }
  const [first, last] = existsSync("/proc/sys/net/ipv4/ip_local_port_range") ? readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/).map(Number) : [];
  return [first ?? NaN, last ?? NaN];
}

if (command === "info" || command === "version") parse(args.slice(1), ["--format"], [], false);
else if (command === "image" && sub === "inspect") { const { positionals } = parse(args.slice(2), ["--format"], [], false); if (positionals.some(value => !["oven/bun:1.3.14", "nginx:1.28-alpine", ...policy.images].includes(value))) refuse("image inspect of a non-fixture image"); }
else if (command === "container" && sub === "ls") parse(args.slice(2), ["--format", "--filter"], ["-a", "-q", "-aq", "--no-trunc", "--all", "--quiet"], false);
else if ((command === "network" || command === "volume") && sub === "ls") parse(args.slice(2), ["--format", "--filter"], ["-q", "--quiet"], false);
else if ((command === "network" || command === "volume") && sub === "inspect") { const { positionals } = parse(args.slice(2), ["--format"], [], false); for (const target of positionals) if (!owned(target, [command])) refuse(`${command} inspect of non-fixture object ${target}`); }
else if (verb === "inspect") { const { positionals } = parse(rest, ["--format"], [], false); if (!positionals.length) refuse("inspect needs targets"); for (const target of positionals) if (!owned(target, ["container"])) refuse(`inspect of non-fixture object ${target}`); }
else if (["start", "stop", "kill", "rm", "wait"].includes(verb)) {
  const { positionals } = parse(rest, verb === "stop" ? ["--time", "-t"] : [], [], false);
  if (!positionals.length) refuse(`${verb} needs targets`);
  for (const target of positionals) if (!owned(target, ["container"])) refuse(`${verb} of non-fixture container ${target}`);
} else if (verb === "logs") { const { positionals } = parse(rest, ["--tail"], [], false); if (positionals.length !== 1 || !owned(positionals[0]!, ["container"])) refuse("logs of non-fixture container"); }
else if (command === "exec") {
  const { positionals } = parse(args.slice(1), ["-u", "--user", "-w", "--workdir"], ["-i", "--interactive"], true);
  if (positionals.length < 2 || !owned(positionals[0]!, ["container"])) refuse(`exec into non-fixture container ${positionals[0]}`);
} else if ((command === "network" || command === "volume") && sub === "create") {
  const { options, positionals } = parse(args.slice(2), command === "network" ? ["--label", "--subnet"] : ["--label"], [], false);
  if (positionals.length !== 1 || !positionals[0]!.startsWith(`${policy.prefix}-`)) refuse(`${command} name must be fixture-prefixed`);
  if (ledger().some(entry => entry.kind === command && entry.name === positionals[0])) refuse(`${command} name ${positionals[0]} already exists in the ledger`);
  if (!options.some(([name, value]) => name === "--label" && typeof value === "string" && /^dev\.drafted\.task=dra37-/.test(value))) refuse("missing DRA-37 task label");
  if (options.some(([name]) => name === "--subnet")) refuse("callers may not choose a subnet; the guard assigns fixture subnets");
  if (command === "network") {
    // Read-only, fail-closed inventory and true CIDR interval overlap.
    let subnet: string | null;
    try {
      subnet = selectFixtureSubnet(readEngineSubnets(engineArgs => {
        const result = Bun.spawnSync([policy.docker, ...engineArgs], { stdout: "pipe", stderr: "pipe" });
        return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
      }));
    } catch (error) { refuse(`network inventory is unavailable or malformed (${error instanceof Error ? error.message : String(error)}); nothing was cleared`); }
    if (!subnet) refuse("no fixture subnet in 10.249.0.0/16 is free of overlap; nothing was cleared");
    args = [...args.slice(0, -1), "--subnet", subnet, args.at(-1)!];
    log({ assignedSubnet: subnet });
  }
  created = command; createdName = positionals[0]!;
} else if (command === "create") {
  const { options, positionals } = parse(args.slice(1), ["--entrypoint", "--label", "--mount", "--name", "--network", "--publish", "--workdir", "--pull"], ["--init"], true);
  const values = (name: string) => options.filter(([option]) => option === name).map(([, value]) => value as string);
  const [name] = values("--name");
  if (values("--name").length !== 1 || !name!.startsWith(`${policy.prefix}-drafted-`)) refuse("create needs exactly one fixture-prefixed --name");
  // Docker keeps container and network names in separate namespaces (Drafted
  // names its app container and network identically).
  if (ledger().some(entry => entry.kind === "container" && entry.name === name)) refuse(`container name ${name} already exists in the ledger`);
  if (values("--network").length !== 1 || !owned(values("--network")[0]!, ["network"])) refuse("create needs exactly one ledger --network");
  if (values("--pull").some(value => value !== "never")) refuse("only --pull=never is allowed");
  if (!values("--label").some(value => /^dev\.drafted\.task=dra37-/.test(value))) refuse("missing DRA-37 task label");
  if (!positionals.length || !policy.images.includes(positionals[0]!)) refuse("the image position must be one recorded immutable fixture image ID");
  // Optional: no publication is the normal internal-container case.
  const publishes = values("--publish");
  if (publishes.length) {
    const [first, last] = ephemeralRange();
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1024 || last > 65535 || first > last) refuse("the OS ephemeral port range is unavailable; publication refused");
    const claimed = new Set(ledger().flatMap(entry => entry.published ?? []));
    for (const publish of publishes) {
      const match = /^127\.0\.0\.1:([1-9]\d*):([1-9]\d*)(\/tcp)?$/.exec(publish);
      if (!match) refuse(`publish ${publish} must be an explicit 127.0.0.1:<host>:<container> port`);
      const host = Number(match[1]);
      if (host < first || host > last || Number(match[2]) > 65535) refuse(`publish ${publish} is outside the OS ephemeral range ${first}-${last}`);
      if (claimed.has(host) || createdPublished.includes(host)) refuse(`publish ${publish} host port is already owned by a fixture container`);
      createdPublished.push(host);
    }
  }
  const targets: string[] = [];
  for (const value of values("--mount")) {
    const mount = parseMount(value);
    targets.push(mount.target);
    if (mount.type === "bind") {
      // The exact transmitted source must already be canonical (no symlink
      // or relative component) and lie inside a private fixture subtree.
      let real = "";
      try { real = realpathSync(mount.source); } catch { refuse(`bind source ${mount.source} does not exist`); }
      if (real !== mount.source) refuse(`bind source ${mount.source} is not canonical (resolves to ${real})`);
      if (!BIND_ROOTS.some(base => real.startsWith(`${base}/`))) refuse(`bind source ${mount.source} is outside the private worktrees/ and state/runtimes/ subtrees`);
      if (/docker\.sock|orbstack/i.test(real)) refuse("host control sockets are never mounted");
    } else if (!ledger().some(entry => entry.kind === "volume" && entry.id === mount.source && entry.name === mount.source)) {
      refuse(`volume ${mount.source} is not an already-ledgered fixture volume`);
    }
  }
  if (new Set(targets).size !== targets.length) refuse("duplicate mount targets are not allowed");
  // The immutable image must not make Docker create an anonymous volume:
  // every declared image volume must be covered by an owned mount above.
  const image = Bun.spawnSync([policy.docker, "image", "inspect", "--format", "{{json .Config}}", positionals[0]!], { stdout: "pipe", stderr: "pipe" });
  if (image.exitCode !== 0) refuse(`image inspect of ${positionals[0]} failed; anonymous volumes cannot be ruled out`);
  let declared: string[] = [];
  try {
    const config = JSON.parse(image.stdout.toString()) as { Volumes?: Record<string, unknown> | null };
    if (config === null || typeof config !== "object") throw new Error("not an object");
    declared = Object.keys(config.Volumes ?? {});
  } catch { refuse(`image config for ${positionals[0]} is malformed; anonymous volumes cannot be ruled out`); }
  const uncovered = declared.filter(volume => !targets.includes(volume));
  if (uncovered.length) refuse(`image ${positionals[0]} would create untracked anonymous volume(s) ${uncovered.join(", ")}`);
  // Keep Drafted's original name as an alias on the private fixture network.
  const at = args.indexOf("--name");
  args = [...args.slice(0, at + 2), "--network-alias", name!.slice(`${policy.prefix}-`.length), ...args.slice(at + 2)];
  created = "container"; createdName = name!;
} else refuse(`unmodelled command ${command} ${sub ?? ""}`);

log({ args });
const child = Bun.spawn([policy.docker, ...args], { stdin: "inherit", stdout: "pipe", stderr: "pipe" });
const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
if (code !== 0) log({ exit: code, command: args.slice(0, 3), stderr: stderr.slice(-1_500) });
if (code === 0 && created) {
  const id = stdout.trim();
  const exact = created === "volume" ? id === createdName : /^[a-f0-9]{64}$/.test(id);
  if (!exact) { log({ unrecognizedCreateOutput: id.slice(0, 200), kind: created, name: createdName }); refuse(`${created} create output is not the exact expected ID; ${createdName} needs manual reconciliation`); }
  // Durable before the caller can act on the new object.
  record({ kind: created, id, name: createdName, ...(createdPublished.length ? { published: createdPublished } : {}) });
}
process.stderr.write(stderr);
process.stdout.write(outbound(stdout));
process.exit(code);
