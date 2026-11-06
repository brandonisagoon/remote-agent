/**
 * DRA-37 REAL-Docker policy guard: the only `docker` the fixture's server,
 * agent and adapter processes can reach. It forwards to the real Docker CLI
 * after enforcing the disposable-fixture policy, so Drafted's actual
 * transports run unchanged against real containers:
 *
 * - Every Drafted resource name (`drafted-[dr]-<24 hex>…`) is given this
 *   fixture's unique prefix on the way in and restored on the way out, so the
 *   engine only ever holds DRA-37-prefixed objects.
 * - Every created container/network/volume is appended to the fixture ledger
 *   BEFORE the caller sees it; cleanup removes exactly those entries.
 * - Effects and exec only target ledger objects; creation only uses the two
 *   pre-recorded image IDs, fixture-private bind sources, ledger networks,
 *   prefixed volumes and loopback-only publishing, with DRA-37 task labels.
 *   Privileged/host namespaces, capabilities, devices, socket mounts, prune
 *   and anything unmodelled are refused.
 *
 * Usage (via the generated bin/docker shim): docker-guard <policy.json> <args...>
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";

type Policy = { root: string; prefix: string; docker: string; images: string[]; ledger: string; log: string };
const policy = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Policy;
const args = process.argv.slice(3);
const log = (entry: object) => appendFileSync(policy.log, JSON.stringify({ at: Date.now(), ...entry }) + "\n");
function refuse(reason: string): never { log({ refused: reason, args }); console.error(`dra37 docker guard refused: ${reason}`); process.exit(125); }

const NAME = /(?<![A-Za-z0-9_.-])(drafted-[dr]-[0-9a-f]{24}[a-z0-9-]*)/g;
const inbound = (value: string) => value.replace(NAME, `${policy.prefix}-$1`);
const outbound = (text: string) => text.split(`${policy.prefix}-drafted-`).join("drafted-");
type Entry = { kind: "container" | "network" | "volume"; id: string; name?: string };
const ledger = (): Entry[] => existsSync(policy.ledger) ? readFileSync(policy.ledger, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const owned = (value: string) => ledger().some(entry => entry.id === value || entry.name === value || (value.length >= 12 && entry.id.startsWith(value)));
const record = (entry: Entry) => appendFileSync(policy.ledger, JSON.stringify({ ...entry, at: new Date().toISOString() }) + "\n", { mode: 0o600 });

const forwarded = args.map(inbound);
// Drafted's proxy reaches its app by the ORIGINAL container name over Docker
// DNS. Give each created container that name as a network alias: aliases are
// scoped to the fixture's private ledger network, so engine object names stay
// prefixed and nothing can collide with shared resources.
// The shared engine's default address pools can be exhausted by other users'
// networks. Never clear anything: give a fixture network an explicit /28 in
// 10.249.0.0/16 that a read-only inspection shows overlaps no existing network.
if (forwarded[0] === "network" && forwarded[1] === "create" && !forwarded.includes("--subnet")) {
  const ids = Bun.spawnSync([policy.docker, "network", "ls", "-q"], { stdout: "pipe" }).stdout.toString().split("\n").filter(Boolean);
  const used = ids.length ? Bun.spawnSync([policy.docker, "network", "inspect", ...ids, "--format", "{{range .IPAM.Config}}{{.Subnet}} {{end}}"], { stdout: "pipe" }).stdout.toString().split(/\s+/).filter(Boolean) : [];
  const third = Array.from({ length: 256 }, (_, index) => index).find(index => !used.some(subnet => subnet.startsWith(`10.249.${index}.`)) && !used.some(subnet => subnet === "10.249.0.0/16"));
  if (third === undefined) refuse("no unused fixture subnet is available; nothing was cleared");
  const subnet = `10.249.${third}.0/28`;
  forwarded.splice(forwarded.length - 1, 0, "--subnet", subnet);
  log({ assignedSubnet: subnet });
}
if (forwarded[0] === "create") {
  const at = forwarded.indexOf("--name");
  const original = at > 0 ? forwarded[at + 1]?.slice(`${policy.prefix}-`.length) : undefined;
  if (original && forwarded[at + 1]!.startsWith(`${policy.prefix}-`)) forwarded.splice(at + 2, 0, "--network-alias", original);
}
const [command, sub] = forwarded;
const positionals = (from: number) => forwarded.slice(from).filter((value, index, all) => !value.startsWith("-") && !(index > 0 && /^--?(?:format|filter|label|name|network|mount|publish|workdir|user|entrypoint|env|e|f|w|u|t|time|signal|s)$/.test(all[index - 1]!)));

function assertCreate(values: string[]) {
  const flags = values.join(" ");
  if (/--privileged|--cap-add|--device|--pid|--ipc|--uts|--userns|--security-opt|--volumes-from|(^|\s)-v(\s|=)|--volume(\s|=)/.test(flags)) refuse("forbidden container privilege or volume flag");
  if (/docker\.sock|orbstack/i.test(flags)) refuse("host control sockets are never mounted");
  if (!values.some(value => /^dev\.drafted\.task=dra37-/.test(value))) refuse("missing DRA-37 task label");
  if (!values.some(value => policy.images.includes(value))) refuse("image is not one of the recorded fixture image IDs");
  values.forEach((value, index) => {
    const flag = values[index - 1];
    if (flag === "--network" && !owned(value)) refuse(`network ${value} is not a fixture ledger network`);
    if (flag === "--publish" && !/^127\.0\.0\.1:\d+:\d+$/.test(value)) refuse("only loopback publishing is allowed");
    if (flag === "--mount") {
      const mount = Object.fromEntries(value.split(",").map(pair => pair.split("=")));
      if (mount.type === "bind" && !(mount.source ?? "").startsWith(`${policy.root}/`)) refuse(`bind source ${mount.source} is outside the fixture root`);
      if (mount.type === "volume" && !(mount.source ?? "").startsWith(`${policy.prefix}-`)) refuse("volume is not a fixture-prefixed volume");
      if (mount.type !== "bind" && mount.type !== "volume") refuse(`mount type ${mount.type} is not allowed`);
    }
  });
}

const readOnly = (command === "info" || command === "version" || (command === "image" && sub === "inspect")
  || (command === "container" && sub === "ls") || (command === "network" && (sub === "ls" || sub === "inspect")) || (command === "volume" && (sub === "ls" || sub === "inspect")));
const containerVerb = command === "container" && ["inspect", "start", "stop", "kill", "rm", "logs", "wait"].includes(sub ?? "") ? sub : null;
if (command === "inspect" || containerVerb === "inspect") { for (const target of positionals(containerVerb ? 2 : 1)) if (!owned(target)) refuse(`inspect of non-fixture object ${target}`); }
else if (containerVerb) { const target = positionals(2)[0]; if (!target || !owned(target)) refuse(`container ${containerVerb} of non-fixture container ${target}`); }
else if (command === "create") assertCreate(forwarded.slice(1));
else if (command === "network" && sub === "create" || command === "volume" && sub === "create") {
  if (!forwarded.some(value => /^dev\.drafted\.task=dra37-/.test(value))) refuse("missing DRA-37 task label");
  if (!forwarded.at(-1)!.startsWith(`${policy.prefix}-`)) refuse("resource name is not fixture-prefixed");
} else if (["start", "stop", "kill", "rm", "exec", "logs", "wait"].includes(command!)) {
  const target = positionals(1)[0];
  if (!target || !owned(target)) refuse(`${command} of non-fixture container ${target}`);
} else if ((command === "network" || command === "volume") && sub === "rm") {
  for (const target of positionals(2)) if (!owned(target)) refuse(`${command} rm of non-fixture object ${target}`);
} else if (!readOnly) refuse(`unmodelled command ${command} ${sub ?? ""}`);

log({ args: forwarded });
const child = Bun.spawn([policy.docker, ...forwarded], { stdin: "inherit", stdout: "pipe", stderr: "pipe" });
const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
if (code !== 0) log({ exit: code, command: forwarded.slice(0, 3), stderr: stderr.slice(-1_500) });
process.stderr.write(stderr);
if (code === 0) {
  const out = stdout.trim();
  // Record before the caller can act on the new object.
  if (command === "create") record({ kind: "container", id: out });
  if (command === "network" && sub === "create") record({ kind: "network", id: out, name: forwarded.at(-1) });
  if (command === "volume" && sub === "create") record({ kind: "volume", id: out, name: out });
}
process.stdout.write(outbound(stdout));
process.exit(code);
