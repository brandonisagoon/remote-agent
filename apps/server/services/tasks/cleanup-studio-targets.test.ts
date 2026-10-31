import { expect, test } from "bun:test";
import path from "node:path";
const services = process.env.DRA244_TEST_ROOT ? path.join(process.env.DRA244_TEST_ROOT, "apps/server/services/tasks") : import.meta.dir;
const { prepareCleanupAdapterResources, assertCleanupAdapterResources } = await import(path.join(services, "cleanup-adapter-resources.ts")) as typeof import("./cleanup-adapter-resources.ts");
const { CleanupObserverBatchInput, cleanupTargetDigest } = await import(path.join(services, "cleanup-observer-schema.ts")) as typeof import("./cleanup-observer-schema.ts");
const { finalizationResourceIdentity } = await import(path.join(services, "finalization-resources.ts")) as typeof import("./finalization-resources.ts");
const { captureAdapterDependencies } = await import(path.join(services, "cleanup-filesystem.ts")) as typeof import("./cleanup-filesystem.ts");

const hash = (n: number) => n.toString(16).padStart(64, "0");
function fixture() {
  const task = { id: "original", primarySessionId: "primary", worktreePath: "/source/original", toolingRevision: "a".repeat(40) };
  const resource = { id: "compose", key: "development-compose", kind: "docker-compose-project", purpose: "development" as const, externalId: "original-project", expiresAt: null, state: "ready", metadata: {
    composeFile: path.join(task.worktreePath, "tools/studio/compose.yaml"), containers: { workspace: hash(1), mysql: hash(2), spatial: hash(3) }, network: { id: hash(4), name: "original-default", subnet: "172.25.0.0/16" }, volumes: ["original-modules", "original-cache", "original-mysql", "original-spatial"],
  } };
  const studio = { file: "/private/studio/original/enrolled.json", sha256: hash(10) }, scope = { taskId: task.id, purpose: "development", project: resource.externalId, studio };
  const configuration = { file: "/private/proxy/nginx.conf", dev: 1, ino: 20, mode: 0o100644 };
  const raw: any[] = [
    ...[1, 2, 3].map(n => ({ kind: "docker-container", id: hash(n), presentAtPrepare: true, scope,
      identity: { createdAt: `original-${n}`, labelsDigest: hash(11), image: `sha256:${hash(12)}`, networks: n === 1 ? [hash(4), hash(5)] : [hash(4)], volumes: resource.metadata.volumes } })),
    { kind: "docker-network", id: hash(4), presentAtPrepare: true, scope, identity: { createdAt: "network-created", labelsDigest: hash(11), name: "original-default" } },
    ...resource.metadata.volumes.map(id => ({ kind: "docker-volume", id, presentAtPrepare: true, scope, identity: { createdAt: "volume-created", labelsDigest: hash(11) } })),
    ...[3200, 8100].map(port => ({ kind: "studio-proxy-route", id: `original-${port}`, presentAtPrepare: true,
      scope: { ...scope, proxyId: hash(6), configuration }, containerId: hash(1), hostname: "original.localhost", listenPort: port, routeDigest: hash(port) })),
  ];
  let absent = false;
  const targets = () => raw.map(target => ({ ...target, identityDigest: cleanupTargetDigest(target) }));
  const context = { task, capability: { version: 1 as const, source: "configured-host" as const, checkout: "/private/tooling", revision: "b".repeat(40), adapter: "/private/tooling/src/cli.ts", adapterSha256: hash(13) } };
  const observer = async ({ request }: { request: unknown }) => {
    const input = CleanupObserverBatchInput.parse(request), frozen = input.observations[0]!.expectedTargets ?? targets();
    return { version: 1, taskId: task.id, observations: [{ version: 1, taskId: task.id, resourceId: resource.id, resourceIdentityDigest: finalizationResourceIdentity(resource).identityDigest,
      adapter: "compose", dependencies: [], stoppedConsumers: [], targets: frozen, absent, presentTargetDigests: absent ? [] : frozen.map(target => target.identityDigest) }] };
  };
  const prepare = () => prepareCleanupAdapterResources({ context, resources: [resource], identities: [{ ...finalizationResourceIdentity(resource), purpose: resource.purpose }] }, observer);
  return { task, resource, raw, context, observer, prepare, removed: () => { absent = true; resource.state = "released"; } };
}
test("the original stock member and route set is prepared once and independently confirmed absent", async () => {
  const f = fixture(), before = structuredClone(f.resource), plan = await f.prepare();
  expect(plan[0]!.targets).toHaveLength(10); expect(f.resource).toEqual(before);
  expect(plan[0]!.targets.filter(target => target.kind === "studio-proxy-route").map(target => [target.hostname, target.listenPort])).toEqual([["original.localhost", 3200], ["original.localhost", 8100]]);
  await expect(assertCleanupAdapterResources({ taskId: f.task.id, resources: [f.resource], plan, removed: true }, f.observer)).rejects.toThrow("independently verified");
  f.removed(); await assertCleanupAdapterResources({ taskId: f.task.id, resources: [f.resource], plan, removed: true }, f.observer);
  await assertCleanupAdapterResources({ taskId: f.task.id, resources: [f.resource], plan, removed: true }, f.observer);
  expect(f.resource.metadata).toEqual(before.metadata);
  for (const root of ["/private/studio", "/private/proxy"]) expect(() => captureAdapterDependencies(root, [f.resource], plan)).toThrow("confirmation inputs");
});
test.each(["missing-member", "extra-member", "missing-route", "mixed-proof", "generic-compose", "shared-network", "shared-proxy", "wrong-container", "wrong-port", "foreign-host", "different-route-host", "duplicate-route-slot", "source-proof", "source-config", "changed-original-volume", "retained-source"])("stock %s cannot broaden prepared cleanup", async kind => {
  const f = fixture(), route = f.raw.find(target => target.kind === "studio-proxy-route");
  if (kind === "missing-member") f.raw.splice(0, 1);
  if (kind === "extra-member") f.raw.push({ ...f.raw[0], id: hash(99) });
  if (kind === "missing-route") f.raw.pop();
  if (kind === "mixed-proof") route.scope = { ...route.scope, studio: { ...route.scope.studio, sha256: hash(99) } };
  if (kind === "generic-compose") f.raw[0].scope = { ...f.raw[0].scope, compose: { file: "/source/compose.yaml", sha256: hash(99), dev: 1, ino: 2, mode: 0o100644, member: "workspace" } };
  if (kind === "shared-network") f.raw.find(target => target.kind === "docker-network").id = hash(5);
  if (kind === "shared-proxy") f.raw[0].id = route.scope.proxyId;
  if (kind === "wrong-container") route.containerId = hash(2);
  if (kind === "wrong-port") route.listenPort = 8200;
  if (kind === "foreign-host") route.hostname = "example.com";
  if (kind === "different-route-host") route.hostname = "foreign.localhost";
  if (kind === "duplicate-route-slot") route.listenPort = 8100;
  if (kind === "source-proof") for (const target of f.raw) target.scope = { ...target.scope, studio: { ...target.scope.studio, file: "/source/original/enrolled.json" } };
  if (kind === "source-config") for (const target of f.raw.filter(target => target.kind === "studio-proxy-route")) target.scope = { ...target.scope, configuration: { ...target.scope.configuration, file: "/source/original/nginx.conf" } };
  if (kind === "changed-original-volume") f.resource.metadata.volumes[0] = "foreign-data";
  if (kind === "retained-source") (f.resource.metadata as Record<string, unknown>).cutoverReceipt = "/private/retained-cutover.json";
  await expect(f.prepare()).rejects.toThrow();
});
test("confirmation cannot relabel a new shared configuration inode or route digest", async () => {
  const f = fixture(), plan = await f.prepare(); f.removed();
  for (const changed of ["inode", "route"]) {
    const observer: typeof f.observer = async input => {
      const result = await f.observer(input), targets = structuredClone(result.observations[0]!.targets);
      const target = targets.find(value => value.kind === "studio-proxy-route")!;
      if (target.kind !== "studio-proxy-route") throw new Error("Missing route");
      if (changed === "inode") target.scope.configuration.ino++; else target.routeDigest = hash(99);
      target.identityDigest = cleanupTargetDigest(target); result.observations[0]!.targets = targets; return result;
    };
    await expect(assertCleanupAdapterResources({ taskId: f.task.id, resources: [f.resource], plan, removed: true }, observer)).rejects.toThrow("identity changed");
  }
});
