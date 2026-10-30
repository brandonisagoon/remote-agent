import { expect, test } from "bun:test";
import { assertCleanupAdapterResources, prepareCleanupAdapterResources } from "./cleanup-adapter-resources.ts";
import { CleanupObserverBatchInput, CleanupTarget, cleanupTargetDigest } from "./cleanup-observer-schema.ts";
import { finalizationResourceIdentity } from "./finalization-resources.ts";

const hash = (digit: string) => digit.repeat(64);
function fixture() {
  const task = { id: "original-task", primarySessionId: "original-primary", worktreePath: "/private/original-worktree", toolingRevision: "a".repeat(40) };
  const context = { task, capability: { version: 1 as const, source: "configured-host" as const, checkout: "/private/configured-tooling", revision: "b".repeat(40), adapter: "/private/configured-tooling/src/cli.ts", adapterSha256: hash("c") } };
  const resources = Array.from({ length: 152 }, (_, index) => ({ id: `resource-${index}`, key: `resource-${index}`, kind: index < 5 ? "docker-container" : "evidence", purpose: "development" as const, externalId: index < 5 ? index.toString(16).padStart(64, "a") : `/private/evidence/${index}`, state: "ready", expiresAt: null, metadata: {} }));
  const identities = resources.slice(0, 5).map(resource => ({ ...finalizationResourceIdentity(resource), purpose: resource.purpose }));
  let calls = 0, absent = false;
  const observe = async ({ request }: { request: unknown }) => {
    calls++;
    const input = CleanupObserverBatchInput.parse(request);
    return { version: 1 as const, taskId: task.id, observations: input.observations.map(item => {
      const resource = resources.find(resource => resource.id === item.resourceId)!;
      const rawTargets = item.expectedTargets ?? [{ kind: "docker-container" as const, id: resource.externalId, presentAtPrepare: true, identityDigest: hash(String(resources.indexOf(resource))), scope: { taskId: task.id, purpose: resource.purpose }, identity: { createdAt: "2026-10-30T00:00:00Z", labelsDigest: hash("d"), image: "sha256:owned-image", networks: [], volumes: [] } }];
      const targets = rawTargets.map(target => { const parsed = CleanupTarget.parse(target); return { ...parsed, identityDigest: cleanupTargetDigest(parsed) }; });
      return { version: 1 as const, taskId: task.id, resourceId: resource.id, resourceIdentityDigest: finalizationResourceIdentity(resource).identityDigest,
        dependencies: resource.id === "resource-0" ? ["resource-1"] : [], adapter: "docker" as const, targets, presentTargetDigests: absent ? [] : targets.map(target => target.identityDigest), absent };
    }) };
  };
  const prepare = () => prepareCleanupAdapterResources({ context, resources, identities }, observe);
  return { context, task, resources, identities, observe, prepare, calls: () => calls, absent: () => { absent = true; } };
}

test("all selected adapters use one bounded batch for a 152-resource plan and one for confirmation", async () => {
  const f = fixture(), plan = await f.prepare(), frozen = JSON.stringify(plan);
  expect(plan).toHaveLength(5); expect(f.calls()).toBe(1);
  for (const resource of f.resources.slice(0, 5)) resource.state = "released";
  f.absent();
  await assertCleanupAdapterResources({ taskId: f.task.id, resources: f.resources, plan, removed: true }, f.observe);
  expect(f.calls()).toBe(2);
  // A retry observes the same targets; no checkpoint or record is rewritten.
  await assertCleanupAdapterResources({ taskId: f.task.id, resources: f.resources, plan, removed: true }, f.observe);
  expect(f.calls()).toBe(3); expect(JSON.stringify(plan)).toBe(frozen);
});

test.each(["task", "resource", "digest", "missing", "extra", "scope", "dependency", "adapter"])("a batch with changed %s cannot become an exact physical plan", async changed => {
  const f = fixture();
  const observer = async (input: Parameters<typeof f.observe>[0]) => {
    const result = await f.observe(input), first = result.observations[0]!;
    if (changed === "task") result.taskId = "another-task";
    if (changed === "resource") first.resourceId = "another-resource";
    if (changed === "digest") first.resourceIdentityDigest = hash("e");
    if (changed === "missing") result.observations.pop();
    if (changed === "extra") result.observations.push({ ...first, resourceId: "another-resource" });
    if (changed === "scope") first.targets[0]!.scope.purpose = "review";
    if (changed === "dependency") first.dependencies = ["foreign-resource"];
    if (changed === "adapter") first.adapter = "runtime" as "docker";
    return result;
  };
  await expect(prepareCleanupAdapterResources({ context: f.context, resources: f.resources, identities: f.identities }, observer)).rejects.toThrow();
});

test("receipt state cannot replace independently observed absence", async () => {
  const f = fixture(), plan = await f.prepare();
  f.resources[0]!.state = "released";
  await expect(assertCleanupAdapterResources({ taskId: f.task.id, resources: f.resources, plan, removed: false }, f.observe)).rejects.toThrow("independently verified");
  f.absent();
  await expect(assertCleanupAdapterResources({ taskId: f.task.id, resources: f.resources, plan, removed: true }, f.observe)).rejects.toThrow("independently verified");
});

test.each(["target", "adapter", "dependency"])("confirmation cannot replace the frozen %s", async changed => {
  const f = fixture(), plan = await f.prepare();
  const observer = async (input: Parameters<typeof f.observe>[0]) => {
    const result = await f.observe(input), first = result.observations[0]!;
    if (changed === "target") first.targets = first.targets.map(target => ({ ...target, id: "f".repeat(64) }));
    if (changed === "adapter") first.adapter = "runtime" as "docker";
    if (changed === "dependency") first.dependencies = ["resource-2"];
    return result;
  };
  await expect(assertCleanupAdapterResources({ taskId: f.task.id, resources: f.resources, plan, removed: false }, observer)).rejects.toThrow();
});

test("a recreated target that was absent at preparation cannot be adopted on retry", async () => {
  const f = fixture();
  const plan = await prepareCleanupAdapterResources({ context: f.context, resources: f.resources, identities: f.identities }, async input => {
    const result = await f.observe(input);
    return { ...result, observations: result.observations.map(item => ({ ...item, absent: true, presentTargetDigests: [], targets: item.targets.map(target => { const value = CleanupTarget.parse({ ...target, presentAtPrepare: false, identity: null }); return { ...value, identityDigest: cleanupTargetDigest(value) }; }) })) };
  });
  await expect(assertCleanupAdapterResources({ taskId: f.task.id, resources: f.resources, plan, removed: false }, f.observe)).rejects.toThrow("invalid resource proof");
});

test("mixed task or capability context fails before another observer starts", async () => {
  const f = fixture(), plan = await f.prepare();
  plan[0]!.observer = { ...plan[0]!.observer, task: { ...plan[0]!.observer.task, primarySessionId: "replacement-primary" } };
  await expect(assertCleanupAdapterResources({ taskId: f.task.id, resources: f.resources, plan, removed: false }, f.observe)).rejects.toThrow("capability changed");
  expect(f.calls()).toBe(1);
});

test("the actual finalization planner binds adapters and rechecks their absence before confirmation", async () => {
  const { prepareFinalizationResources, assertFinalizationResources } = await import("./finalization-resources.ts");
  const f = fixture(), resources = f.resources.slice(0, 5);
  const observation = { adapters: f.observe, endpointAbsent: async () => {}, rootIdle: async () => {}, browserAbsent: async () => {} };
  const input = { resources, taskId: f.task.id, sessionId: f.task.primarySessionId, toolingRoot: f.context.capability.checkout,
    sourcePaths: [], deliveries: [], ownership: { ownedPaths: [] }, originalWork: true, adapterContext: f.context };
  const plan = await prepareFinalizationResources(input, observation);
  expect(plan.every(entry => entry.disposition === "retire-adapter")).toBeTrue();
  expect(f.calls()).toBe(1);
  await assertFinalizationResources({ taskId: f.task.id, resources, plan, removed: false, originalWork: true }, observation);
  for (const resource of resources) resource.state = "released";
  await expect(assertFinalizationResources({ taskId: f.task.id, resources, plan, removed: true, originalWork: true }, observation)).rejects.toThrow("independently verified");
  f.absent();
  await assertFinalizationResources({ taskId: f.task.id, resources, plan, removed: true, originalWork: true }, observation);
  expect(f.calls()).toBe(4);
});

test("physical planning cannot infer a capability or silently drop unsupported resources", async () => {
  const { prepareFinalizationResources } = await import("./finalization-resources.ts");
  const f = fixture(), input = { resources: f.resources.slice(0, 5), taskId: f.task.id, sessionId: f.task.primarySessionId,
    toolingRoot: f.context.capability.checkout, sourcePaths: [], deliveries: [], ownership: { ownedPaths: [] }, originalWork: true };
  const observation = { adapters: f.observe, endpointAbsent: async () => {}, rootIdle: async () => {}, browserAbsent: async () => {} };
  await expect(prepareFinalizationResources(input, observation)).rejects.toThrow("server-bound");
  await expect(prepareFinalizationResources({ ...input, resources: f.resources, adapterContext: f.context }, observation)).rejects.toThrow("exact resource plans");
  expect(f.calls()).toBe(0);
});

test("a cyclic dependency plan is rejected before any cleanup is possible", async () => {
  const { prepareFinalizationResources } = await import("./finalization-resources.ts");
  const f = fixture();
  const observation = { adapters: async (input: Parameters<typeof f.observe>[0]) => {
    const result = await f.observe(input); result.observations[1]!.dependencies = ["resource-0"]; return result;
  }, endpointAbsent: async () => {}, rootIdle: async () => {}, browserAbsent: async () => {} };
  await expect(prepareFinalizationResources({ resources: f.resources.slice(0, 5), taskId: f.task.id, sessionId: f.task.primarySessionId,
    toolingRoot: f.context.capability.checkout, sourcePaths: [], deliveries: [], ownership: { ownedPaths: [] }, originalWork: true, adapterContext: f.context }, observation)).rejects.toThrow("cycle");
});

test("malformed observer keys and values are never exposed as validation diagnostics", async () => {
  const f = fixture();
  try {
    await prepareCleanupAdapterResources({ context: f.context, resources: f.resources, identities: f.identities }, async input => ({ ...await f.observe(input), "private-provider-secret": "private-provider-value" }));
    throw new Error("Unexpected observer success");
  } catch (error) {
    expect(String(error)).toContain("absence is unverified");
    expect(String(error)).not.toContain("private-provider");
  }
});
