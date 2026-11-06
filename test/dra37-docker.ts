/**
 * DRA-37 SYNTHETIC Docker CLI for the server's observer process only. Drafted's
 * actual `compute observe` runs unchanged and calls `docker`; this answers
 * from the fixture records, and reports the application's state from the
 * REAL task-owned process (pid alive + exact command + identity token).
 * It never fabricates a running app: a dead or replaced process is stopped.
 * Any command it does not model fails, so unexpected calls are visible.
 *
 * Usage (via the generated bin/docker wrapper): docker <args...>
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const apps = process.env.DRA37_DOCKER_APPS ?? process.argv[2]!;
const args = process.argv.slice(3);
import { appendFileSync } from "node:fs";
appendFileSync(path.join(apps, "docker-calls.jsonl"), JSON.stringify({ at: Date.now(), args }) + "\n");
type ContainerRecord = { id: string; image: string; createdAt: string; running: boolean; labels: Record<string, string>; pid?: number; token?: string };
const tasks = readdirSync(apps).filter(name => name.endsWith(".container.json")).map(name => name.slice(0, -".container.json".length));
const read = <T>(file: string): T | null => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as T : null;

function live(task: string, record: ContainerRecord): boolean {
  if (!record.pid) return false;
  try { process.kill(record.pid, 0); } catch { return false; }
  const identityFile = path.join(apps, `${task}.identity.json`);
  const command = Bun.spawnSync(["ps", "-o", "command=", "-p", String(record.pid)], { stdout: "pipe" }).stdout.toString();
  if (!command.includes("dra37-app.ts") || !command.includes(identityFile)) return false;
  return read<{ token: string }>(identityFile)?.token === record.token;
}
function app(task: string) {
  const record = read<ContainerRecord>(path.join(apps, `${task}.container.json`))!;
  const network = read<{ id: string; name: string }>(path.join(apps, `${task}.network.json`));
  const running = live(task, record);
  return { Id: record.id, Image: record.image, Created: record.createdAt,
    State: { Running: running, Paused: false, Restarting: false, Pid: running ? record.pid : 0, Status: running ? "running" : "exited", StartedAt: record.createdAt },
    Config: { Labels: record.labels }, HostConfig: { PortBindings: {} }, Mounts: [],
    NetworkSettings: { Networks: network ? { [network.name]: { NetworkID: network.id } } : {} } };
}
const proxies = Object.fromEntries(tasks.flatMap(task => { const proxy = read<{ Id: string }>(path.join(apps, `${task}.proxy.json`)); return proxy ? [[proxy.Id, proxy]] : []; }));
const containers = Object.fromEntries(tasks.map(task => [read<ContainerRecord>(path.join(apps, `${task}.container.json`))!.id, task]));

function fail(message: string): never { appendFileSync(path.join(apps, "docker-calls.jsonl"), JSON.stringify({ at: Date.now(), failed: message }) + "\n"); console.error(`dra37 synthetic docker: ${message}`); process.exit(1); }
if (args[0] === "container" && args[1] === "ls") { console.log([...Object.keys(containers), ...Object.keys(proxies)].join("\n")); process.exit(0); }
if (args[0] === "inspect") {
  const rows = args.slice(1).filter(value => !value.startsWith("-")).map(id => containers[id] ? app(containers[id]!) : proxies[id] ?? fail(`unknown object ${id}`));
  console.log(JSON.stringify(rows)); process.exit(0);
}
if (args[0] === "network" && args[1] === "inspect") {
  const network = tasks.map(task => read<{ id: string; name: string; createdAt: string }>(path.join(apps, `${task}.network.json`))).find(value => value?.id === args[2]);
  if (!network) fail(`unknown network ${args[2]}`);
  console.log(JSON.stringify([{ Id: network.id, Name: network.name, Created: network.createdAt }])); process.exit(0);
}
fail(`unmodelled command: ${args.join(" ")}`);
