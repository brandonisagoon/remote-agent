import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../../app.ts";
import { createTestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import { confirmComputeDelivery, reconcileObservedCompute } from "./compute-admission.ts";
import { refreshComputeObservation } from "./compute-observer.ts";
import { collectComputeEvidence, computeEvidenceState } from "./compute-observation.ts";
import { considerComputeSuspension } from "./compute-suspension.ts";
import { classifyCompute } from "./compute-decision.ts";

const clientRoot = process.env.DRAFTED_INTEGRATION_ROOT;
const enabled = process.env.DRAFTED_STUDIO_DOCKER_TEST === "1" && Boolean(clientRoot);
const bunImage = "sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4";
const nginxImage = "sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function git(cwd: string, ...args: string[]) {
  const child = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (child.exitCode) throw new Error(child.stderr.toString()); return child.stdout.toString().trim();
}
async function put(file: string, bytes: string) { await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await writeFile(file, bytes, { mode: 0o600 }); }
async function repo(root: string) { await mkdir(root); git(root, "init", "-q"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.invalid"); }

/** Actual Docker IDs/lifetimes/mounts, private live activity sockets, NGINX,
 * relay, SQLite and Unix routes. Isolation adapters translate ONLY the nonce
 * network's stock name and ephemeral host ports, and bound inventory to this
 * fixture's nonce label. Product callbacks are disposable measured children;
 * this does not assert the full real Greenfield application/queue behavior.
 * Durable instruction delivery is seeded; no real agent/provider is launched. */
function nginxFor(bindings: any[]) {
  return `events {}\nhttp { log_format drafted escape=json '{"requestId":"$upstream_http_x_drafted_request_id","status":$status,"durationSeconds":$request_time,"at":$msec}';\n${bindings.map((route: any) => `server { listen ${route.listenPort}; access_log /tmp/drafted-traffic-${route.id}.jsonl drafted; location / { resolver 127.0.0.11 valid=1s; set $backend http://${route.relayHost}:${route.relayPort}; proxy_pass $backend; proxy_set_header Host $http_host; proxy_buffering off; } }`).join("\n")}\n}`;
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "studio-pair-")));
  await chmod(root, 0o700); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const nonce = `studio-pair-${crypto.randomUUID()}`, project = nonce, sharedName = `${nonce}-proxy`;
  const client = await import(path.join(clientRoot!, "src/compute-coverage.ts"));
  const rawDocker = client.computeDocker as (args: string[], input?: Uint8Array) => Promise<string>;
  const containers: string[] = [], networks: string[] = [], volumes: string[] = [];
  cleanups.push(async () => {
    for (const id of containers.reverse()) {
      const [actual] = JSON.parse(await rawDocker(["inspect", id]));
      if (actual.Config.Labels["dev.drafted.disposable"] !== nonce) throw new Error("Disposable cleanup owner changed");
      await rawDocker(["rm", "-f", id]);
    }
    for (const id of networks.reverse()) { const [actual] = JSON.parse(await rawDocker(["network", "inspect", id])); if (actual.Labels["dev.drafted.disposable"] !== nonce) throw new Error("Disposable network owner changed"); await rawDocker(["network", "rm", id]); }
    for (const id of volumes) { const [actual] = JSON.parse(await rawDocker(["volume", "inspect", id])); if (actual.Labels["dev.drafted.disposable"] !== nonce) throw new Error("Disposable volume owner changed"); await rawDocker(["volume", "rm", id]); }
  });
  const product = path.join(root, "product"), tooling = path.join(root, "tooling"), studioRoot = path.join(root, "records");
  await repo(product); git(product, "checkout", "-b", "codex/fixture");
  await put(path.join(product, ".gitignore"), ".local/\n");
  await put(path.join(product, "tools/studio/compose.yaml"), "services: {}\n");
  await put(path.join(product, "tools/studio/dev.ts"), `
import { appendFile } from 'node:fs/promises';
try {
const m=await import('/run/drafted/compute-studio.js');
await appendFile('/workspace/.local/launches', 'launch\\n');
const hook=await m.prepareStudioCompute(process.env);
const children=[];
for (const service of ['generation','api','web']) children.push(await hook.launch(service,m.studioComputeCommands[service],(_command,env)=>Bun.spawn(['bun','--no-env-file','/workspace/service.ts',service],{env,stdout:'inherit',stderr:'inherit'})));
await Promise.all(children.map(child=>child.exited));
await hook.close();
} catch(error) { await appendFile('/workspace/.local/product-error',String(error.stack??error).slice(0,4000)); throw error; }
`);
  await put(path.join(product, "service.ts"), `
import { readFile } from 'node:fs/promises';
const service=process.argv[2], port={generation:8200,api:8100,web:3200}[service];
const mode=async()=>JSON.parse(await readFile('/workspace/.local/mode.json','utf8')).mode;
let source;
if (!(service==='generation' && await mode()==='missing')) {
 const m=await import(process.env.DRAFTED_COMPUTE_ACTIVITY_MODULE);
 source=await m.createComputeActivitySource(process.env.DRAFTED_COMPUTE_ACTIVITY_DIRECTORY,service,{coverage:'incomplete',idleProbes:['queue']});
 source.registerIdleProbe('queue',async()=>await mode()!=='queued');
 await source.markCoverageComplete();
}
let end, ticking=false;
setInterval(async()=>{ if(ticking||!source||service!=='generation')return;ticking=true;try{if(await mode()==='busy')end??=await source.begin('background-job'); else {end?.();end=undefined;}}finally{ticking=false;} },50);
let foreign;
Bun.serve({hostname:'127.0.0.1',port,fetch(request){const action=new URL(request.url).pathname;if(service==='api'&&action==='/listener/start')foreign??=Bun.serve({hostname:'127.0.0.11',port:19001,fetch:()=>new Response('unmeasured')});if(service==='api'&&action==='/listener/stop'){foreign?.stop(true);foreign=undefined;}return new Response('ready',{headers:{'content-length':'5'}});}});
`);
  for (const file of ["tools/studio/dev-processes.ts", "tools/studio/local-server.ts", "tools/studio/proxy-traffic.ts", "tools/studio/proxy-configuration.ts", "apps/studio-generation/src/worker-main.ts", "packages/studio-server/background-activity.ts"]) await put(path.join(product, file), "// Disposable product boundary; measured service.ts owns the fixture callback.\n");
  git(product, "add", "."); git(product, "commit", "-qm", "Disposable measured product");
  const revision = git(product, "rev-parse", "HEAD"), common = git(product, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const workspace = { version: 1, root: product, branch: "codex/fixture", slug: nonce, project };
  await put(path.join(product, ".local/home-studio/workspace.json"), JSON.stringify(workspace));
  await put(path.join(common, "home-studio-workspaces", `${project}.json`), JSON.stringify(workspace));
  await put(path.join(product, ".local/mode.json"), JSON.stringify({ mode: "missing" }));
  const ownedLabels = ["--label", `dev.drafted.disposable=${nonce}`, "--label", `com.docker.compose.project=${project}`];
  const networkId = (await rawDocker(["network", "create", ...ownedLabels, "--label", "com.docker.compose.network=default", `${project}_default`])).trim(); networks.push(networkId);
  const sharedId = (await rawDocker(["network", "create", "--label", `dev.drafted.disposable=${nonce}`, sharedName])).trim(); networks.push(sharedId);
  for (const suffix of ["mysql", "spatial"]) { const id = `${nonce}-${suffix}`; await rawDocker(["volume", "create", ...ownedLabels, id]); volumes.push(id); }
  const ids: Record<string, string> = {};
  for (const service of ["workspace", "mysql", "spatial"]) {
    const id = (await rawDocker(["create", "--pull=never", "--name", `${nonce}-${service}`, ...ownedLabels,
      "--label", `com.docker.compose.service=${service}`, "--label", `com.docker.compose.project.config_files=${product}/tools/studio/compose.yaml`,
      "--label", `com.docker.compose.project.working_dir=${product}/tools/studio`, "--network", networkId,
      ...(service === "workspace" ? ["--mount", `type=bind,source=${product},target=/workspace`, "--tmpfs", "/tmp", "--env", "DRAFTED_CONTAINER=1", "--env", `STUDIO_ENVIRONMENT_ID=local/${nonce}`]
        : ["--mount", `type=volume,source=${nonce}-${service},target=/data`]), bunImage, ...(service === "workspace" ? ["sleep", "infinity"] : ["bun", "-e", "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"])] )).trim();
    ids[service] = id; containers.push(id);
    if (service === "workspace") await rawDocker(["network", "connect", "--alias", `drafted-${nonce}`, sharedId, id]);
    await rawDocker(["start", id]);
    if (service !== "workspace") await rawDocker(["exec", id, "bun", "-e", `await Bun.write('/data/retained','${nonce}-${service}')`]);
  }
  const resourceId = `${nonce}-group`;
  const { finalizationDigest } = await import(path.join(clientRoot!, "src/finalization-plan.ts"));
  const nginxFile = path.join(root, "nginx.conf");
  await put(nginxFile, nginxFor([8100, 3200].map((port, index) => ({ id: `studio-${finalizationDigest({ taskId: nonce, resourceId, containerId: ids.workspace, port }).slice(0, 24)}`, listenPort: port, relayHost: `drafted-${nonce}`, relayPort: 18100 + index }))));
  const proxyId = (await rawDocker(["create", "--pull=never", "--name", `${nonce}-nginx`, "--label", `dev.drafted.disposable=${nonce}`, "--network", sharedId,
    "--publish", "127.0.0.1::8100", "--publish", "127.0.0.1::3200", "--mount", `type=bind,source=${nginxFile},target=/etc/nginx/nginx.conf,readonly`, nginxImage])).trim(); containers.push(proxyId);
  const [proxyRaw] = JSON.parse(await rawDocker(["inspect", proxyId]));
  // Docker allocates ephemeral ports at start. This map is read by the adapter.
  const translationFile = path.join(root, "translation.json");
  await put(translationFile, JSON.stringify({ ports: {} }));
  await repo(tooling);
  const dockerSource = `
import { computeDocker } from ${JSON.stringify(path.join(clientRoot!, "src/compute-coverage.ts"))};
import { readFile } from 'node:fs/promises';
export async function docker(args,input) {
 if(args[0]==='container'&&args[1]==='ls')args=[...args,'--filter',${JSON.stringify(`label=dev.drafted.disposable=${nonce}`)}];
 let out;try {out=await computeDocker(args,input);}catch(error){throw new Error('Disposable Docker '+args.slice(0,2).join(' ')+': '+error.message,{cause:error});}
 if(args[0]==='inspect') {const rows=JSON.parse(out);const {ports}=JSON.parse(await readFile(${JSON.stringify(translationFile)},'utf8'));
 for(const row of rows) {const nets=row.NetworkSettings?.Networks;if(nets?.[${JSON.stringify(sharedName)}]){nets['drafted-proxy']=nets[${JSON.stringify(sharedName)}];delete nets[${JSON.stringify(sharedName)}];}
 if(row.Id===${JSON.stringify(proxyId)})for(const port of [8100,3200])for(const binding of row.HostConfig.PortBindings[port+'/tcp']??[])if(row.NetworkSettings.Ports?.[port+'/tcp']?.some(value=>value.HostIp==='127.0.0.1'&&value.HostPort===String(ports[port])))binding.HostPort=String(port);}
 return JSON.stringify(rows);}
 if(args[0]==='network'&&args[1]==='inspect')return JSON.stringify(JSON.parse(out).map(row=>row.Id===${JSON.stringify(sharedId)}?{...row,Name:'drafted-proxy'}:row));
 return out;
}
export async function request(url,init){const target=new URL(url);const {ports}=JSON.parse(await readFile(${JSON.stringify(translationFile)},'utf8'));if(ports[target.port])target.port=String(ports[target.port]);return fetch(target,init);}
`;
  await put(path.join(tooling, "docker.ts"), dockerSource);
  await put(path.join(tooling, "observe.ts"), `import {observeCompute} from ${JSON.stringify(path.join(clientRoot!, "src/compute-coverage.ts"))};import {readTrafficJson,readTrafficBytes} from ${JSON.stringify(path.join(clientRoot!, "src/compute-traffic-journal.ts"))};import {docker,request} from './docker.ts';const input=JSON.parse(await Bun.stdin.text());try{console.log(JSON.stringify(await observeCompute(input,{docker,request,json:readTrafficJson,bytes:file=>readTrafficBytes(file,4*1024*1024,false)})));}catch(error){await Bun.write(${JSON.stringify(path.join(root, 'observer-error.txt'))},error.stack??String(error));throw error;}\n`);
  await put(path.join(tooling, "runtime.md"), "Disposable exact Docker observer.\n");
  await put(path.join(tooling, ".remote-agent-capabilities.json"), JSON.stringify({ version: 1, capabilities: { runtime: { instructions: "runtime.md", adapter: "observe.ts", observationContracts: ["compute-traffic/v1"] } } }));
  git(tooling, "add", "."); git(tooling, "commit", "-qm", "Fixture observer with isolated address translation");
  const toolingRevision = git(tooling, "rev-parse", "HEAD"), socket = path.join(root, "control.sock");
  const db = await createTestDatabase(); cleanups.push(db.cleanup); const { prisma } = db;
  const config = testConfig({ installRoot: path.join(root, "install"), controlIpcPath: socket, compute: ComputePolicy.parse({ enabled: true, slots: 1, quietPeriodSeconds: 30, decisionApiKey: "fixture" }) });
  config.repository = { ...config.repository, root: product, tooling: { root: tooling, revision: toolingRevision } }; config.repositories = { [config.repository.id]: config.repository };
  const checkout = path.join(config.installRoot, "tooling", config.repository.id, toolingRevision); await mkdir(path.dirname(checkout), { recursive: true }); git(tooling, "worktree", "add", "--detach", checkout, toolingRevision); await put(`${checkout}.ready`, `${toolingRevision}\n`);
  const task = await prisma.remoteTask.create({ data: { id: nonce, requestKey: nonce, repositoryId: config.repository.id, machineId: config.machine, primarySessionId: `${nonce}-primary`, worktreePath: product, branchName: workspace.branch, phase: "working", toolingRoot: tooling, pinnedToolingRoot: checkout, toolingRevision } });
  await prisma.runtimeSession.create({ data: { id: task.primarySessionId!, scopeKey: task.id, agentCommand: "codex", role: "primary", status: "idle", cwd: product, repositoryId: task.repositoryId, machineId: task.machineId } });
  const resource = await prisma.remoteTaskResource.create({ data: { id: resourceId, taskId: task.id, key: "development-compose", kind: "docker-compose-project", purpose: "development", externalId: project, state: "ready", metadata: { composeFile: path.join(product, "tools/studio/compose.yaml"), containers: ids, network: networkId, volumes } } });
  const runtime = createFakeAgentRuntime([{ id: task.primarySessionId!, role: "primary", status: "idle", cwd: product, repositoryId: task.repositoryId, machineId: task.machineId }]);
  const app = createApp({ config, prisma, agentRuntime: runtime, trustLocal: true }), server = Bun.serve({ unix: socket, fetch: app.fetch }); cleanups.push(async () => { await server.stop(true); });
  const { taskRegistry } = await import(path.join(clientRoot!, "src/control.ts")), registry = taskRegistry(socket, task.id);
  const { docker, request } = await import(path.join(tooling, "docker.ts"));
  const ownership = await import(path.join(clientRoot!, "src/compute-studio-ownership.ts")), { readCleanupFile } = await import(path.join(clientRoot!, "src/cleanup-observer-files.ts"));
  const ownershipDeps = { docker, read: readCleanupFile, git: async (args: string[], cwd: string) => git(cwd, ...args) };
  const inspect = (task: any, key: string, network: any) => ownership.inspectStudioComputeOwnership(task, key, network, ownershipDeps);
  const verify = (task: any, proof: any) => ownership.verifyStudioComputeOwnership(task, proof, ownershipDeps);
  const [shared] = JSON.parse(await rawDocker(["network", "inspect", sharedId]));
  const configuration = { ownerUrl: "http://127.0.0.1:1/", ownerTokenFile: path.join(root, "token"), expectedConfigurationSha256: sha(await readFile(nginxFile)), proxy: { id: proxyId, imageId: nginxImage, createdAt: proxyRaw.Created }, sharedNetwork: { id: sharedId, createdAt: shared.Created } };
  await put(configuration.ownerTokenFile, config.apiKey);
  const preparation = await import(path.join(clientRoot!, "src/compute-studio-prepare.ts"));
  let loseEnrollment = true, enrollmentPosts = 0;
  const owner = preparation.studioComputeOwner(configuration, async (url: any, init: any) => {
    const response = await fetch(url, { ...init, unix: socket });
    if (!response.ok) { const diagnostic = await readFile(path.join(root, "observer-error.txt"), "utf8").catch(() => ""); throw new Error(`Fixture owner response ${response.status}: ${diagnostic}`); }
    if (init.method === "POST") { enrollmentPosts++; if (response.ok && loseEnrollment) { loseEnrollment = false; await response.text(); throw new Error("Lost committed owner reply"); } }
    return response;
  });
  const proxy = async (action: string, value: any) => {
    const text = nginxFor(value.bindings);
    if (action === "plan") return { configurationPath: nginxFile, candidateSha256: sha(text), previousWorkers: { status: "verified", workers: [] } };
    expect(await readFile(nginxFile, "utf8")).toBe(text); // Disposable initial config only; shared-proxy rewrite is separately tested.
    const [before] = JSON.parse(await rawDocker(["inspect", proxyId]));
    if (!before.State.Running) await rawDocker(["start", proxyId]);
    const [after] = JSON.parse(await rawDocker(["inspect", proxyId]));
    if (!after.NetworkSettings.Ports?.["8100/tcp"]?.[0] || !after.NetworkSettings.Ports?.["3200/tcp"]?.[0]) { const log = Bun.spawn(["docker", "logs", proxyId], { stdout: "pipe", stderr: "pipe" }); const [stdout, stderr] = await Promise.all([new Response(log.stdout).text(), new Response(log.stderr).text(), log.exited]); throw new Error(`Disposable proxy failed: ${stdout} ${stderr}`); }
    await put(translationFile, JSON.stringify({ ports: Object.fromEntries([8100, 3200].map(port => [port, Number(after.NetworkSettings.Ports[`${port}/tcp`][0].HostPort)])) }));
    return { configurationSha256: sha(text), coverageComplete: false };
  };
  const prepare = () => preparation.prepareStudioCompute({ registry, key: resource.key, configuration, root: studioRoot }, { owner, docker, inspect, verify, proxy });
  const { readStudioComputeRecord, verifyStudioComputeFiles } = await import(path.join(clientRoot!, "src/compute-studio-state.ts"));
  const { savedComputeRevision } = await import(path.join(clientRoot!, "src/compute-saved.ts"));
  const { startInstrumentedStudio } = await import(path.join(clientRoot!, "src/compute-studio-start.ts"));
  const { manageResource } = await import(path.join(clientRoot!, "src/resources.ts"));
  const { continueDevelopmentIntent } = await import(path.join(clientRoot!, "src/development-intent.ts"));
  let loseExec = true, launches = 0;
  const launchDocker = async (args: string[], input?: Uint8Array) => { const output = await docker(args, input); if (args[0] === "exec" && args[1] === "-d") { launches++; if (loseExec) { loseExec = false; throw new Error("Lost detached exec reply"); } } return output; };
  const dependencies = { docker, ownership: verify, files: verifyStudioComputeFiles, revision: savedComputeRevision, launch: (record: any, guard: () => Promise<void>) => startInstrumentedStudio(record, guard, launchDocker) };
  const manage = async (input: any) => { try { return await manageResource({ ...input, studio: { root: studioRoot, dependencies } }); } catch(error) { const diagnostic = await readFile(path.join(product, ".local/product-error"), "utf8").catch(() => ""); if (diagnostic) throw new Error(`Disposable product: ${diagnostic}`, { cause: error }); throw error; } };
  const context = { prisma, config, runtime }, admission = { prisma, machineId: config.machine, policy: config.compute! };
  async function deliver() {
    const environment = await prisma.computeEnvironment.findFirstOrThrow({ where: { taskId: task.id } });
    const offer = await prisma.computeOffer.findFirstOrThrow({ where: { environmentId: environment.id, state: "queued" } });
    await prisma.runtimeInstruction.update({ where: { id: offer.instructionId }, data: { state: "dispatching", executionRequestId: offer.instructionId } });
    await prisma.runtimeSession.update({ where: { id: task.primarySessionId! }, data: { status: "active" } });
    await prisma.runtimeLifecycleEvent.create({ data: { id: crypto.randomUUID(), runtimeSessionId: task.primarySessionId!, requestId: offer.instructionId, phase: "started", occurredAt: new Date() } });
    await confirmComputeDelivery({ ...admission, sessionId: task.primarySessionId!, requestId: offer.instructionId }); return offer;
  }
  async function settled(offer: any) { await prisma.runtimeInstruction.update({ where: { id: offer.instructionId }, data: { state: "completed" } }); await prisma.runtimeSession.update({ where: { id: task.primarySessionId! }, data: { status: "idle" } }); await prisma.runtimeLifecycleEvent.create({ data: { id: crypto.randomUUID(), runtimeSessionId: task.primarySessionId!, requestId: offer.instructionId, phase: "completed", occurredAt: new Date() } }); }
  const mode = (value: string) => put(path.join(product, ".local/mode.json"), JSON.stringify({ mode: value }));
  async function waitProduct() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const responses = await Promise.all([8100, 3200].map(port => request(`http://127.0.0.1:${port}/`, { headers: { Host: `${nonce}.localhost` } }).then(async (response: Response) => response.ok && await response.text() === "ready").catch(() => false)));
      if (responses.every(Boolean)) return;
      const diagnostic = await readFile(path.join(product, ".local/product-error"), "utf8").catch(() => "");
      if (diagnostic) throw new Error(`Disposable product: ${diagnostic}`);
      await Bun.sleep(50);
    }
    throw new Error("Disposable measured product did not become reachable through its real proxy");
  }
  const readRecord = async () => (await readStudioComputeRecord(await registry.task(), resource.key, studioRoot))!.record;
  return { ...context, admission, root, task, resource, registry, ids, rawDocker, request, prepare, manage, deliver, settled, mode, waitProduct, readRecord, proxyId, proxyRaw, volumes, networks, product, revision, enrollmentPosts: () => enrollmentPosts, launches: () => launches,
    continueSaved: () => continueDevelopmentIntent(registry, manage) };
}

test.skipIf(!enabled)("actual legacy Docker/Unix enrollment preserves the original group and requires live measured work before suspension", async () => {
  const f = await fixture(), before = await f.prisma.remoteTaskResource.findMany({ where: { taskId: f.task.id } });
  await expect(f.prepare().catch((error: Error) => { if (error.message !== "Lost committed owner reply") console.error(error); throw error; })).rejects.toThrow("Lost committed owner reply");
  expect(await f.prisma.computeEnvironment.count()).toBe(1); expect(await f.prisma.computeOffer.count()).toBe(0);
  const prepared = await f.prepare(); expect(prepared).toMatchObject({ state: "stopped", coverage: "incomplete", enrolled: true });
  expect(f.enrollmentPosts()).toBe(2); expect(f.launches()).toBe(0);
  const record = await f.readRecord(), environmentId = record.environmentId;
  const refresh = () => refreshComputeObservation({ ...f, environmentId });
  expect((await refresh()).state).toBe("stopped");
  const resume = (offer?: string) => f.manage({ registry: f.registry, key: f.resource.key, action: "resume", ...(offer ? { computeOffer: offer } : {}) });
  expect(await resume()).toMatchObject({ phase: "waiting-compute" });
  expect(f.launches()).toBe(0);
  const offer = await f.deliver(); await resume(offer.id); await f.settled(offer);
  expect(f.launches()).toBe(1);
  await resume(offer.id); expect(f.launches()).toBe(1); await f.waitProduct();
  await expect(refresh()).rejects.toThrow(); // missing generation contributor is never idle
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "development-compute-intent" } })).toBe(0);
  await f.manage({ registry: f.registry, key: f.resource.key, action: "stop" });
  await refresh(); await reconcileObservedCompute({ ...f.admission, environmentId, runtime: f.runtime });
  await f.mode("busy");
  // Missing measurement keeps the existing uncertain allocation reserved. A
  // same-offer resume recovers it; physical stop alone must not free capacity.
  expect(await f.prisma.computeSlot.count({ where: { allocationId: offer.id } })).toBe(1);
  expect(await resume(offer.id)).toMatchObject({ observed: "running-instrumented-studio" }); await f.waitProduct();
  expect(await f.prisma.computeOffer.count()).toBe(1);
  expect(f.launches()).toBe(2);
  let observation: any;
  for (let i = 0; i < 20; i++) { try { observation = await refresh(); if (observation.operations.active > 0) break; } catch { /* wait only for disposable startup */ } await Bun.sleep(100); }
  expect(observation?.operations).toMatchObject({ coverage: "complete", active: 1 });
  await reconcileObservedCompute({ ...f.admission, environmentId, runtime: f.runtime });
  expect((await collectComputeEvidence({ ...f, environmentId })).eligible).toBe(false);
  await f.mode("idle");
  // An app listener on the resolver address is not Docker's embedded DNS.
  const extraListener = await f.request("http://127.0.0.1:8100/listener/start", { headers: { Host: `${f.task.id}.localhost` } });
  expect(extraListener.ok).toBe(true); await extraListener.text();
  expect(await f.rawDocker(["exec", f.ids.workspace!, "cat", "/proc/net/tcp"])).toMatch(/0B00007F:4A39\s+\S+\s+0A/);
  expect((await refresh()).coverage).toBe("incomplete");
  expect((await collectComputeEvidence({ ...f, environmentId })).eligible).toBe(false);
  const removedListener = await f.request("http://127.0.0.1:8100/listener/stop", { headers: { Host: `${f.task.id}.localhost` } });
  expect(removedListener.ok).toBe(true); await removedListener.text();
  expect(await f.rawDocker(["exec", f.ids.workspace!, "cat", "/proc/net/tcp"])).not.toMatch(/0B00007F:4A39\s+\S+\s+0A/);
  let evidence: any;
  for (let i = 0; i < 45; i++) { observation = await refresh(); evidence = await collectComputeEvidence({ ...f, environmentId }); if (evidence.eligible) break; await Bun.sleep(1000); }
  if (!evidence.eligible) console.error(JSON.stringify({ coverage: observation.coverage, operations: observation.operations, traffic: evidence.evidence.traffic, activity: evidence.evidence.activity }));
  expect(evidence.eligible).toBe(true);
  const decision = await considerComputeSuspension({ ...f, environmentId, requestKey: "measured-disposable-idle" }, { classify: (input, options) => classifyCompute(input, { ...options, fetch: async () => Response.json({ answers: [{ type: "choice", name: "compute_action", choice: "suspend-compute", confidence: 0.92 }] }) }) });
  expect(decision.outcome).toBe("suspension-recorded");
  const beforeContinuation = { environment: await f.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: environmentId } }), traffic: await f.prisma.computeTraffic.findMany({ where: { environmentId } }) };
  try { await f.continueSaved(); }
  catch (error) {
    const file = path.join(tmpdir(), `dra182-studio-continuation-${crypto.randomUUID()}.private.json`);
    const members = JSON.parse(await f.rawDocker(["inspect", ...Object.values(f.ids)]));
    await writeFile(file, JSON.stringify({ at: new Date().toISOString(), stage: "continueDevelopmentIntent", taskId: f.task.id, decision, before: beforeContinuation,
      after: { environment: await f.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: environmentId } }), traffic: await f.prisma.computeTraffic.findMany({ where: { environmentId } }),
        evidence: await computeEvidenceState({ ...f, environmentId, allowStopped: true }).catch((failure: Error) => ({ error: failure.message })),
        members: members.map((row: any) => ({ id: row.Id, service: row.Config.Labels["com.docker.compose.service"], state: row.State })) }, error: error instanceof Error ? error.message : String(error) }, null, 2), { flag: "wx", mode: 0o600 });
    console.error(`Disposable continuation diagnostic: ${file}`); throw error;
  }
  await refresh(); await reconcileObservedCompute({ ...f.admission, environmentId, runtime: f.runtime });
  expect(await f.prisma.computeSlot.count({ where: { allocationId: { not: null } } })).toBe(0);
  expect((await f.registry.task()).developmentIntent).toMatchObject({ reason: "runtime-suspended", state: "complete" });
  expect(await f.prisma.remoteTaskResource.findMany({ where: { taskId: f.task.id } })).toEqual(before);
  const rows = JSON.parse(await f.rawDocker(["inspect", ...Object.values(f.ids)])); expect(rows.every((row: any) => !row.State.Running)).toBe(true);
  const [proxy] = JSON.parse(await f.rawDocker(["inspect", f.proxyId])); expect(proxy).toMatchObject({ Id: f.proxyRaw.Id, Created: f.proxyRaw.Created, Image: f.proxyRaw.Image, State: { Running: true } });
  expect(git(f.product, "rev-parse", "HEAD")).toBe(f.revision); expect((await f.registry.task()).ownerPaused).toBe(false);
  // Real data bytes remain on the same volumes after a second saved resume.
  expect(await resume()).toMatchObject({ phase: "waiting-compute" }); const last = await f.deliver(); await resume(last.id); await f.settled(last);
  for (const service of ["mysql", "spatial"]) expect((await f.rawDocker(["exec", f.ids[service]!, "cat", "/data/retained"])).trim()).toBe(`${f.task.id}-${service}`);
  expect(f.launches()).toBe(3); expect(await f.prisma.runtimeSession.count()).toBe(1); expect(await f.prisma.remoteTaskResource.count()).toBe(1);
}, 240_000);

test.skipIf(!enabled)("actual Linux installer accepts the real bounded Studio module set", async () => {
  const { studioComputeModules, buildStudioComputeBundle } = await import(path.join(clientRoot!, "src/compute-studio-bundle.ts"));
  const { studioContainerCommand } = await import(path.join(clientRoot!, "src/compute-studio-start.ts"));
  const { computeDocker } = await import(path.join(clientRoot!, "src/compute-coverage.ts"));
  const files = [];
  for (const [name, source, target] of studioComputeModules) files.push({ name, bytes: (await buildStudioComputeBundle(source, target)).toString("base64") });
  files.push({ name: "studio-compute.json", bytes: Buffer.from("{}").toString("base64") });
  const installation = { version: 1, taskId: "installer-fixture", environmentId: crypto.randomUUID(), recordDigest: "a".repeat(64), files: files.map(file => ({ name: file.name, sha256: sha(Buffer.from(file.bytes, "base64")) })) };
  const script = await studioContainerCommand("install", { installation, files });
  const id = (await computeDocker(["create", "--pull=never", "--label", "dev.drafted.disposable=studio-installer", "--network", "none", bunImage, "sleep", "infinity"])).trim();
  try {
    await computeDocker(["start", id]);
    const result = JSON.parse(await computeDocker(["exec", "-i", id, "bun", "--no-env-file", "-"], script));
    expect(result).toEqual({ installed: true, recordDigest: installation.recordDigest });
  } finally {
    const [row] = JSON.parse(await computeDocker(["inspect", id]));
    if (row.Image !== bunImage || row.Config.Labels["dev.drafted.disposable"] !== "studio-installer") throw new Error("Installer cleanup owner changed");
    await computeDocker(["rm", "-f", id]);
  }
}, 30_000);
