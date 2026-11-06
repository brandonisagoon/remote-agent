/**
 * DRA-37: one adapter invocation in its own Bun process. It runs the pinned
 * Drafted checkout's ACTUAL runtime algorithm (`manageRuntime`) and its
 * control client against the real Remote Agent server's control socket.
 *
 * SYNTHETIC, by explicit scope: the Docker and cloud-provider transports.
 * The "container" is a real task-owned loopback app process (dra37-app.ts),
 * started on the exact URL Drafted assigned, inspected by its exact pid and
 * command identity, and stopped by killing exactly that process. Providers
 * return a fixture database URL; no PlanetScale/cloud resource exists.
 * Health is Drafted's own real fetch against the running app.
 *
 * Usage: bun test/dra37-runtime-turn.ts up|stop [compute-offer-id]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [action, offer] = process.argv.slice(2) as ["up" | "stop" | "status", string | undefined];
const env = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
const drafted = env("DRA37_DRAFTED_ROOT"), socket = env("DRA37_SOCKET"), taskId = env("DRA37_TASK");
const stateDirectory = env("DRA37_STATE"), recipe = env("DRA37_RECIPE"), apps = env("DRA37_APPS");
const control = await import(path.join(drafted, "src/control.ts"));
const runtime = await import(path.join(drafted, "src/runtime.ts"));
const { savePrivate } = await import(path.join(drafted, "src/runtime-config.ts"));

type Container = { id: string; image: string; createdAt: string; running: boolean; labels: Record<string, string>; pid?: number; port?: number; token?: string };
const recordFile = path.join(apps, `${taskId}.container.json`), identityFile = path.join(apps, `${taskId}.identity.json`);
const effectsFile = path.join(apps, `${taskId}.effects.jsonl`);
const effect = (name: string, detail: object = {}) => writeFileSync(effectsFile, JSON.stringify({ at: Date.now(), pid: process.pid, effect: name, ...detail }) + "\n", { flag: "a" });
const read = (): Container | null => existsSync(recordFile) ? JSON.parse(readFileSync(recordFile, "utf8")) : null;
const write = (value: Container) => writeFileSync(recordFile, JSON.stringify(value), { mode: 0o600 });

/** Exact identity: the recorded pid is alive AND its command line is this
 * task's app with this task's identity file AND the identity token matches. */
function liveIdentity(container: Container): boolean {
  if (!container.pid) return false;
  try { process.kill(container.pid, 0); } catch { return false; }
  const command = Bun.spawnSync(["ps", "-o", "command=", "-p", String(container.pid)], { stdout: "pipe" }).stdout.toString();
  if (!command.includes("dra37-app.ts") || !command.includes(identityFile)) return false;
  try { return JSON.parse(readFileSync(identityFile, "utf8")).token === container.token; } catch { return false; }
}

let created: { urls: Record<string, string> } | undefined;
// SYNTHETIC traffic sidecar (Drafted's nginx proxy) and network: recorded
// Docker objects only. The application itself is a real process.
const network = { id: Bun.CryptoHasher.hash("sha256", `network:${taskId}`, "hex") as string, createdAt: "dra37-network", name: `dra37-${taskId}` };
const proxyFile = path.join(apps, `${taskId}.proxy.json`);
const computeDocker = async (args: string[]) => {
  const options = (flag: string) => args.flatMap((value, index) => value === flag ? [args[index + 1]!] : []);
  const proxy = existsSync(proxyFile) ? JSON.parse(readFileSync(proxyFile, "utf8")) : null;
  const labels = { "dev.drafted.task": taskId, "dev.drafted.purpose": "development" };
  if (args[0] === "image") return JSON.stringify([{ Id: `sha256:${"b".repeat(64)}` }]);
  if (args[0] === "network") return JSON.stringify([{ Id: network.id, Name: network.name, Created: network.createdAt, Labels: labels }]);
  if (args[0] === "container" && args[1] === "ls") return proxy?.Id ?? "";
  if (args[0] === "create") {
    const mount = options("--mount").map(value => Object.fromEntries(value.split(",").map(pair => pair.split("="))));
    const created = { Id: "d".repeat(64), Image: `sha256:${"b".repeat(64)}`, Created: "dra37-proxy",
      State: { Running: false, Status: "created", StartedAt: "0001-01-01T00:00:00Z" },
      Config: { Labels: Object.fromEntries(options("--label").map(value => value.split("="))) },
      HostConfig: { NetworkMode: options("--network")[0], PortBindings: Object.fromEntries(options("--publish").map(value => { const [HostIp, HostPort, port] = value.split(":"); return [`${port}/tcp`, [{ HostIp, HostPort }]]; })) },
      Mounts: mount.map(value => ({ Source: value.source, Destination: value.target, RW: value.readonly === undefined && !options("--mount").some(raw => raw.includes(`target=${value.target},readonly`)) })),
      NetworkSettings: { Networks: { [network.name]: { NetworkID: "", EndpointID: "" } } } };
    writeFileSync(proxyFile, JSON.stringify(created)); effect("create-proxy");
    return created.Id;
  }
  if (args[0] === "inspect") return JSON.stringify([proxy]);
  if (args[0] === "start") { writeFileSync(proxyFile, JSON.stringify({ ...proxy, State: { Running: true, Status: "running", StartedAt: new Date().toISOString() },
    NetworkSettings: { Networks: { [network.name]: { NetworkID: network.id, EndpointID: "e".repeat(64) } } } })); effect("start-proxy"); return ""; }
  if (args[0] === "stop") { writeFileSync(proxyFile, JSON.stringify({ ...proxy, State: { ...proxy.State, Running: false, Status: "exited" } })); effect("stop-proxy"); return ""; }
  throw new Error(`Unexpected synthetic traffic Docker command: ${args.join(" ")}`);
};
const docker = {
  preflight: async () => { effect("preflight"); },
  create: async (state: any, directory: string, environment: unknown) => {
    await savePrivate(path.join(directory, "app", "environment.json"), environment);
    created = state;
    state.network = { id: network.id, createdAt: network.createdAt };
    writeFileSync(path.join(apps, `${taskId}.network.json`), JSON.stringify(network), { mode: 0o600 });
    const container: Container = { id: Bun.CryptoHasher.hash("sha256", `${taskId}:${state.purpose}`, "hex") as string, image: `sha256:${"a".repeat(64)}`,
      createdAt: new Date().toISOString(), running: false, labels: { "dev.drafted.task": taskId, "dev.drafted.purpose": state.purpose, "dev.drafted.runtime": "1" } };
    write(container); effect("create", { id: container.id });
    return { id: container.id, image: container.image, createdAt: container.createdAt, running: false, labels: container.labels };
  },
  inspect: async (id: string) => {
    const container = read();
    if (!container || container.id !== id) return null;
    const running = liveIdentity(container);
    return { id: container.id, image: container.image, createdAt: container.createdAt, running, labels: container.labels };
  },
  start: async (id: string) => {
    const container = read();
    if (!container || container.id !== id) throw new Error("Unknown synthetic container");
    if (liveIdentity(container)) return;
    const url = created?.urls?.api ?? JSON.parse(readFileSync(path.join(stateDirectory, "runtimes", taskId, "development", "runtime.json"), "utf8")).urls.api;
    const port = Number(new URL(url).port);
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "dra37-app.ts"), String(port), identityFile, taskId],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    child.unref();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try { const identity = JSON.parse(readFileSync(identityFile, "utf8")); if (identity.pid === child.pid) { write({ ...container, pid: child.pid, port, token: identity.token, running: true }); effect("start", { appPid: child.pid, port }); return; } } catch { /* starting */ }
      await Bun.sleep(25);
    }
    child.kill("SIGKILL"); throw new Error("Synthetic application did not start");
  },
  exec: async (_id: string, commands: string[][]) => { effect("exec", { commands }); },
  stop: async (id: string) => {
    const container = read();
    if (!container || container.id !== id) throw new Error("Unknown synthetic container");
    if (liveIdentity(container)) {
      process.kill(container.pid!, "SIGTERM");
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && liveIdentity(container)) await Bun.sleep(25);
      if (liveIdentity(container)) throw new Error("Synthetic application did not stop");
    }
    write({ ...container, running: false }); effect("stop", { appPid: container.pid });
  },
  remove: async () => { throw new Error("DRA-37 never removes the task-owned application"); },
  releaseDependencies: async () => { throw new Error("DRA-37 never releases task dependencies"); },
};
const remote = path.join(apps, `${taskId}.providers.json`);
const providers = {
  preflight: async () => {},
  create: async (provider: string, name: string, record: (value: unknown) => Promise<void>) => {
    const receipt = { provider, id: `${provider}-${taskId}`, name }; await record(receipt);
    writeFileSync(remote, JSON.stringify({ [provider]: receipt })); effect(`create-${provider}`);
    return { DATABASE_URL: "mysql://fixture@fixture.invalid/fixture" };
  },
  inspect: async (receipt: { provider: string }) => existsSync(remote) && Boolean(JSON.parse(readFileSync(remote, "utf8"))[receipt.provider]),
  resume: async () => ({ DATABASE_URL: "mysql://fixture@fixture.invalid/fixture" }),
  schema: async (_receipt: unknown, operation: (env: unknown) => Promise<unknown>) => operation({ DATABASE_URL: "mysql://fixture@fixture.invalid/fixture" }),
  release: async () => { throw new Error("DRA-37 never releases provider data"); },
};
const credentials = JSON.parse(readFileSync(JSON.parse(readFileSync(recipe, "utf8")).credentialsFile, "utf8"));
const result = await runtime.manageRuntime({ registry: control.taskRegistry(socket, taskId), stateDirectory, docker, computeDocker, providers: () => providers,
  clerkCredentials: async () => credentials, action, purpose: "development", ...(action === "up" ? { configFile: recipe } : {}), ...(offer ? { computeOffer: offer } : {}) });
console.log(JSON.stringify(result));
