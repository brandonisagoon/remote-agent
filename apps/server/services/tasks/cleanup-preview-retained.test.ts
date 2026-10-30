import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CleanupObserverBatchInput, CleanupTarget, cleanupTargetDigest } from "./cleanup-observer-schema.ts";
import { assertFinalizationResources, finalizationDigest, finalizationResourceIdentity, prepareFinalizationResources, type FinalizationResourceRecord, type ResourceObservation } from "./finalization-resources.ts";
import { capturedPreviewInputs } from "./cleanup-preview-retained.ts";
import type { runCleanupResourceObserver } from "./cleanup-resource-observer.ts";

const roots: string[] = [], originalFetch = globalThis.fetch;
afterEach(async () => { globalThis.fetch = originalFetch; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const accountId = "a".repeat(32), zoneId = "b".repeat(32), tunnelId = "11111111-2222-3333-4444-555555555555", hostname = "drafted-dra98-dev.brandongoon.com", endpoint = "http://127.0.0.1:19913";
async function fixture(client?: string) {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), "server-preview-capture-"))); roots.push(parent); await chmod(parent, 0o700);
  const root = path.join(parent, "environment"), config = path.join(root, "cloudflared.yml"), connector = path.join(root, "tunnel.json"), certificate = path.join(parent, "brand.pem");
  await mkdir(root, { mode: 0o700 });
  await writeFile(config, JSON.stringify({ tunnel: tunnelId, "credentials-file": connector, origincert: certificate, ingress: [{ hostname, service: endpoint }, { service: "http_status:404" }] }), { mode: 0o600 });
  await writeFile(connector, JSON.stringify({ AccountTag: accountId, TunnelID: tunnelId, TunnelSecret: "synthetic-connector" }), { mode: 0o400 });
  await writeFile(certificate, `-----BEGIN ARGO TUNNEL TOKEN-----\n${Buffer.from(JSON.stringify({ accountID: accountId, zoneID: zoneId, apiToken: "synthetic-origin" })).toString("base64")}\n-----END ARGO TUNNEL TOKEN-----\n`, { mode: 0o600 });
  const resource = (id: string, kind: string, externalId: string, metadata: Record<string, unknown>, state = "ready"): FinalizationResourceRecord => ({ id, key: id, kind, externalId, metadata, state, purpose: "development", expiresAt: null });
  const resources = [resource("development-env-directory", "private-directory", root, {}),
    resource("tunnel", "cloudflare-tunnel", "drafted-dra98-dev-task", { tunnelId, account: `Cubic ${accountId}`, configPath: config, credentialsFile: `${connector} (0400)`, ingress: `${hostname} -> ${endpoint}; everything else http_status:404`, taskOwned: true }),
    resource("dns", "cloudflare-dns-record", hostname, { needed: `proxied CNAME drafted-dra98-dev -> ${tunnelId}.cfargotunnel.com in zone brandongoon.com (${zoneId})`, preExisting: false }),
    resource("endpoint", "local-http", endpoint, { acceptedHosts: [hostname], launcher: "run.sh proxy" }, "released")];
  const original = { version: 1 as const, source: "configured-host" as const, checkout: path.join(parent, "old-tooling"), revision: "c".repeat(40), adapter: path.join(parent, "old-tooling/cli.ts"), adapterSha256: "d".repeat(64) };
  const current = { ...original, checkout: path.join(parent, "current-tooling"), adapter: path.join(parent, "current-tooling/cli.ts"), revision: "e".repeat(40) };
  const task = { id: "task", primarySessionId: "primary", worktreePath: path.join(parent, "original-checkout"), toolingRevision: "f".repeat(40) };
  const calls: Parameters<typeof runCleanupResourceObserver>[0][] = []; let present = true;
  const native = client ? await import(path.join(client, "src/cleanup-observer.ts")) : undefined;
  const providerCalls: string[] = [];
  globalThis.fetch = (async (url: string, options: RequestInit) => {
    const route = url.replace("https://api.cloudflare.com/client/v4", ""); providerCalls.push(route);
    expect(options.method).toBe("GET"); expect(new Headers(options.headers).get("authorization")).toBe("Bearer synthetic-origin");
    const result = route === `/zones/${zoneId}` ? { id: zoneId, name: "brandongoon.com", account: { id: accountId } }
      : route.includes("/dns_records") ? [] : route.includes("/cfd_tunnel") ? (present ? { id: tunnelId, name: resources[1]!.externalId, config_src: "local" } : null) : null;
    return Response.json({ success: true, result });
  }) as typeof fetch;
  const observe: typeof runCleanupResourceObserver = async input => {
    calls.push(input); const request = CleanupObserverBatchInput.parse(input.request);
    if (native) return native.observeCleanupBatch(request);
    return { version: 1, taskId: task.id, observations: request.observations.map(item => {
      const record = resources.find(record => record.id === item.resourceId)!;
      const raw = record.id === "tunnel" ? { kind: "local-ingress-route", id: hostname, scope: { taskId: task.id, purpose: "development", configFile: config, tunnelId }, hostname, sourceDigest: "a".repeat(64), routeDigest: "b".repeat(64), presentAtPrepare: true }
        : { kind: "cloudflare-dns-record", id: "d".repeat(32), scope: { taskId: task.id, purpose: "development", zoneId }, name: hostname, type: "CNAME", contentDigest: "b".repeat(64), presentAtPrepare: true };
      const target = CleanupTarget.parse({ ...raw, identityDigest: "0".repeat(64) }); target.identityDigest = cleanupTargetDigest(target);
      const targets = item.expectedTargets ?? [target];
      return { version: 1, taskId: task.id, resourceId: item.resourceId, resourceIdentityDigest: finalizationResourceIdentity(record).identityDigest, adapter: "preview", dependencies: [], stoppedConsumers: [], targets, presentTargetDigests: present ? targets.map(target => target.identityDigest) : [], absent: !present };
    }) };
  };
  const observation: ResourceObservation = { adapters: observe, rootIdle: async () => {}, endpointAbsent: async () => {}, browserAbsent: async () => {} };
  const plan = await prepareFinalizationResources({ taskId: task.id, sessionId: task.primarySessionId, resources, toolingRoot: original.checkout, sourcePaths: [], deliveries: [], ownership: { ownedPaths: [root] }, originalWork: true, adapterContext: { task, capability: original } }, observation);
  const tree = plan.find(entry => entry.disposition === "retire-tree"); if (!tree || tree.disposition !== "retire-tree") throw new Error("Missing tree");
  const capture = async () => {
    if (client) await (await import(path.join(client, "src/quarantine.ts"))).capturePreparedTree(tree.target, { taskId: task.id, resourceId: tree.id, planDigest: finalizationDigest(tree.target) });
    else {
      await mkdir(tree.target.quarantine.directory, { mode: 0o700 }); const q = await lstat(tree.target.quarantine.directory), source = tree.target.inventory[0]!;
      await writeFile(tree.target.quarantine.journal, JSON.stringify({ version: 1, taskId: task.id, resourceId: tree.id, planDigest: finalizationDigest(tree.target), sourcePath: root, capturedPath: tree.target.quarantine.path, source: { dev: source.dev, ino: source.ino, mode: source.mode }, quarantine: { dev: q.dev, ino: q.ino } }), { mode: 0o600, flag: "wx" });
      await rename(root, tree.target.quarantine.path);
    }
    present = false; resources.forEach(resource => resource.state = "released");
  };
  const verify = (resolver: (() => Promise<typeof current>) | undefined = async () => current) => assertFinalizationResources({ taskId: task.id, resources, plan, removed: true, originalWork: true, previewObserver: resolver }, observation);
  return { root, parent, config, connector, certificate, plan, tree, resources, original, current, capture, verify, calls, providerCalls, observation, task };
}

test("captured preview confirmation selects only a compatible observer and preserves frozen targets on retry", async () => {
  const f = await fixture(), frozen = JSON.stringify(f.plan); await f.capture();
  await expect(f.verify()).resolves.toBeUndefined();
  const call = f.calls.at(-1)!; expect(call.capability).toEqual(f.original); expect(call.compatibleCapability).toEqual(f.current);
  const request = CleanupObserverBatchInput.parse(call.request); expect(request.retainedPreviewInputs).toHaveLength(1);
  expect(request.retainedPreviewInputs![0]!.planDigest).toBe(finalizationDigest(f.tree.target));
  const bytes = await readFile(f.tree.target.quarantine.journal); await f.verify();
  expect(await readFile(f.tree.target.quarantine.journal)).toEqual(bytes); expect(JSON.stringify(f.plan)).toBe(frozen);
});

test.each(["source", "config", "connector", "journal", "root", "identity", "other-file"])("captured preview %s changes fail before observer/provider reads", async changed => {
  const f = await fixture(); await f.capture(); const before = f.calls.length;
  if (changed === "source") await mkdir(f.root, { mode: 0o700 });
  if (changed === "config" || changed === "connector") { const file = path.join(f.tree.target.quarantine.path, path.basename(changed === "config" ? f.config : f.connector)); await chmod(file, 0o600); await writeFile(file, "changed"); }
  if (changed === "journal") { const value = JSON.parse(await readFile(f.tree.target.quarantine.journal, "utf8")); value.taskId = "foreign"; await writeFile(f.tree.target.quarantine.journal, JSON.stringify(value)); }
  if (changed === "root") { await rename(f.tree.target.quarantine.path, path.join(f.parent, "saved")); await mkdir(f.tree.target.quarantine.path, { mode: 0o700 }); }
  if (changed === "identity") f.resources[0]!.metadata = { changed: true };
  if (changed === "other-file") await writeFile(path.join(f.tree.target.quarantine.path, "extra"), "new", { mode: 0o600 });
  await expect(f.verify()).rejects.toThrow(); expect(f.calls).toHaveLength(before);
});

test("a present original environment never requests compatibility and a missing current capability cannot fall back", async () => {
  const f = await fixture(); expect(await capturedPreviewInputs({ taskId: f.task.id, resources: f.resources, plan: f.plan })).toEqual([]);
  await f.capture(); const before = f.calls.length;
  await expect(assertFinalizationResources({ taskId: f.task.id, resources: f.resources, plan: f.plan, removed: true }, f.observation)).rejects.toThrow("compatible configured observer");
  expect(f.calls).toHaveLength(before);
});

const client = process.env.DRAFTED_CLEANUP_CLIENT;
test.skipIf(!client)("actual client native capture and captured credential GET confirmation retain the server-produced plan", async () => {
  const f = await fixture(client!), frozen = JSON.stringify(f.plan), original = await readFile(f.certificate); await f.capture(); const before = f.providerCalls.length;
  // The old request has no captured-input contract and cannot confirm this
  // genuinely missing source configuration. The recovery retains its targets.
  const request = { version: 1, task: f.task, resources: f.resources, stage: "confirm", observations: f.plan.flatMap(entry => entry.disposition === "retire-adapter" ? [{ resourceId: entry.id, expectedTargets: entry.targets }] : []) };
  await expect((await import(path.join(client!, "src/cleanup-observer.ts"))).observeCleanupBatch(request)).rejects.toThrow();
  await f.verify(); await f.verify();
  expect(f.providerCalls.length).toBeGreaterThan(before); expect(await readFile(f.certificate)).toEqual(original);
  expect(JSON.stringify(f.plan)).toBe(frozen); expect(await lstat(f.root).catch(() => null)).toBeNull();
});


test("recovery does not change the observer or request for an unrelated physical adapter", async () => {
  const f = await fixture();
  const resource: FinalizationResourceRecord = { id: "volume", key: "volume", kind: "docker-volume", purpose: "development", externalId: "exact-volume", state: "released", expiresAt: null, metadata: {} };
  const raw = { kind: "docker-volume", id: resource.externalId, scope: { taskId: f.task.id, purpose: "development" }, identity: null, presentAtPrepare: false } as const;
  const target = { ...raw, identityDigest: cleanupTargetDigest(raw) };
  f.resources.push(resource);
  f.plan.push({ ...finalizationResourceIdentity(resource), purpose: "development", disposition: "retire-adapter", adapter: "docker", dependencies: [], stoppedConsumers: [], targets: [target], observer: { task: f.task, capability: f.original } });
  const prior = f.observation.adapters!; let ordinary = 0;
  f.observation.adapters = async input => {
    const request = CleanupObserverBatchInput.parse(input.request);
    if (request.observations.some(item => item.resourceId === resource.id)) {
      expect(request.observations).toHaveLength(1); expect(request.retainedPreviewInputs).toBeUndefined(); expect(input.compatibleCapability).toBeUndefined(); expect(input.capability).toEqual(f.original); ordinary++;
      return { version: 1, taskId: f.task.id, observations: [{ version: 1, taskId: f.task.id, resourceId: resource.id, resourceIdentityDigest: finalizationResourceIdentity(resource).identityDigest, adapter: "docker", dependencies: [], stoppedConsumers: [], targets: [target], presentTargetDigests: [], absent: true }] };
    }
    return prior(input);
  };
  await f.capture(); await f.verify(); expect(ordinary).toBe(1);
});

test("a compatible observer cannot substitute a frozen preview target", async () => {
  const f = await fixture(); await f.capture(); const prior = f.observation.adapters!;
  f.observation.adapters = async input => {
    const result = await prior(input) as any;
    const target = result.observations[0].targets[0]; target.hostname = "another.example.com"; target.identityDigest = cleanupTargetDigest(target);
    return result;
  };
  await expect(f.verify()).rejects.toThrow("target identity changed");
});
