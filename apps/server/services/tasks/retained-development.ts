import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

// This local, read-only correspondence is mirrored by Remote Agent's intent
// selector. It never opens endpoint credentials, Docker or a provider. Unknown
// retained-app formats must fail closed, rather than select the old sources.
const Hash = z.string().regex(/^[a-f0-9]{64}$/), Text = z.string().min(1).max(4096);
const Absolute = Text.refine(value => path.isAbsolute(value) && path.normalize(value) === value);
const Pin = z.object({ file: Absolute, sha256: Hash });
const Binding = z.object({ resourceKey: Text, resourceId: Text, provider: z.enum(["docker", "planetscale", "neon"]), recipeFile: Absolute.optional(), recipeSha256: Hash.optional() });
const Endpoint = Pin.extend({ binding: Binding });
const Provenance = z.object({ receiptFile: Absolute, receiptSha256: Hash, mappingFile: Absolute, mappingSha256: Hash });
const Identity = z.object({ taskId: Text, primarySessionId: Text, worktreePath: Absolute, toolingRevision: Text, purpose: z.literal("development") });
const Config = Identity.extend({ version: z.literal(1), key: Text, directory: Absolute, transferConfigurationFile: Absolute, source: Pin, sourceDigest: Hash,
  workspace: z.object({ resourceKey: Text, originalId: Hash, id: Hash, createdAt: Text, image: Text }),
  endpoints: z.object({ mysql: Endpoint, spatial: Endpoint, terrain: Endpoint }) });
const Retained = z.object({ version: z.literal(1), configurationFile: Absolute, configurationSha256: Hash, receiptFile: Absolute,
  operation: z.string().uuid(), launchSha256: Hash, containerIdentityDigest: Hash, dataResourceKeys: z.array(Text).length(3) });
const Boundary = z.object({ version: z.literal(1), taskId: Text, purpose: z.literal("development"), sourceIds: z.array(Hash).length(1), targetIds: z.array(Text).length(3),
  resources: z.array(z.object({ key: Text, kind: Text, purpose: Text, externalId: Text })).min(1).max(100) });
const App = z.object({ version: z.literal(1), configurationSha256: Hash, operation: z.string().uuid(), launchSha256: Hash,
  container: z.object({ id: Hash, createdAt: Text, identityDigest: Hash }), boundary: Boundary });
const Store = z.object({ name: Text, kind: z.literal("sql"), mode: z.enum(["copy", "reuse-target"]), sourceId: Hash.optional(), targetId: Text,
  sourceFile: Absolute.optional(), sourceSha256: Hash.optional(), sourceBinding: Binding.optional(), sourcePreparation: z.literal("stopped-mysql").optional(),
  targetFile: Absolute, targetSha256: Hash, targetBinding: Binding, provenance: Provenance.optional() });
const Transfer = z.object({ version: z.literal(1), boundary: Boundary, stores: z.array(Store).length(3) });
const Source = Identity.extend({ version: z.literal(1), composeKey: Text, composeSha256: Hash, containerKey: Text, volumeKey: Text });
const Cutover = z.object({ project: Text, branchId: Text, state: z.literal("migrated"), completedAt: Text,
  containers: z.array(z.object({ id: Hash, service: Text })).max(100) });
const Mapping = z.object({ taskId: Text, purpose: z.literal("development"), project: Text, worktree: Absolute, sourceId: Hash,
  composeFiles: z.array(Absolute).min(1).max(100), branchId: Text, copy: z.array(z.object({ database: Text })).min(1).max(100) });
type Resource = { id?: string; key: string; kind: string; purpose: string; externalId: string; state: string; metadata?: unknown };
export type RetainedDevelopmentTask = { id: string; primarySessionId?: string | null; worktreePath?: string | null; toolingRevision?: string | null; resources: Resource[] };
export type RetainedDevelopment = { resourceIds: string[]; containers: Array<{ id: string; state: "stopped" | "absent"; image: string; project: string; service?: string; createdAt?: string }> };
export type RetainedDevelopmentReader = (file: string, sha256?: string) => Promise<unknown>;
const object = (value: unknown) => z.record(z.string(), z.unknown()).parse(value);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const equal = (left: unknown, right: unknown) => digest(left) === digest(right);
const sorted = (values: string[]) => [...values].sort();

export async function retainedDevelopment(task: RetainedDevelopmentTask, read: RetainedDevelopmentReader): Promise<RetainedDevelopment> {
  const resourceIds = new Set<string>(), containers = new Map<string, RetainedDevelopment["containers"][number]>();
  const apps = task.resources.filter(resource => resource.purpose === "development" && Object.hasOwn(resource.metadata ?? {}, "retainedStudio"));
  if (apps.length > 1) throw new Error("Retained development app ownership is ambiguous");
  for (const app of apps) {
    if (app.kind !== "docker-container" || !app.id || app.state === "released") throw new Error("Retained development app receipt changed");
    const metadata = object(app.metadata), retained = Retained.parse(metadata.retainedStudio);
    const reads = new Map<string, Promise<unknown>>();
    const local: RetainedDevelopmentReader = (file, sha) => {
      if (task.worktreePath && (file === task.worktreePath || file.startsWith(`${task.worktreePath}${path.sep}`))) throw new Error("Retained development proof must remain outside the product checkout");
      const key = `${file}:${sha ?? ""}`;
      if (!reads.has(key)) { if (reads.size >= 16) throw new Error("Retained development proof exceeds its file bound"); reads.set(key, read(file, sha)); }
      return reads.get(key)!;
    };
    const config = Config.parse(await local(retained.configurationFile, retained.configurationSha256));
    const identity = (value: z.infer<typeof Identity>) => {
      if (value.taskId !== task.id || value.primarySessionId !== task.primarySessionId || value.worktreePath !== task.worktreePath || value.toolingRevision !== task.toolingRevision || value.purpose !== "development") throw new Error("Retained development original task identity changed");
    };
    identity(config);
    if (config.key !== app.key || metadata.image !== config.workspace.image || retained.receiptFile !== path.join(config.directory, "app.json")) throw new Error("Retained development app configuration changed");
    const rawState = object(await local(retained.receiptFile)), state = App.parse(rawState);
    if (state.configurationSha256 !== retained.configurationSha256 || state.operation !== retained.operation || state.launchSha256 !== retained.launchSha256
      || state.container.id !== app.externalId || state.container.identityDigest !== retained.containerIdentityDigest) throw new Error("Retained development saved app identity changed");
    const rawTransfer = object(await local(config.transferConfigurationFile)), transfer = Transfer.parse(rawTransfer);
    const completed = z.object({ version: z.literal(1), phase: z.literal("complete"), configHash: Hash, completedAt: Text }).parse(await local(path.join(path.dirname(config.transferConfigurationFile), "transfer.json")));
    if (completed.configHash !== digest(rawTransfer) || !equal(rawTransfer.boundary, rawState.boundary) || state.boundary.taskId !== task.id) throw new Error("Retained development migration is incomplete or changed");
    const resource = (key: string, kind: string) => {
      const rows = task.resources.filter(value => value.key === key);
      if (rows.length !== 1 || !rows[0]!.id || rows[0]!.kind !== kind || rows[0]!.purpose !== "development" || rows[0]!.state === "released") throw new Error("Retained development resource correspondence changed");
      return rows[0]!;
    };
    for (const saved of state.boundary.resources) {
      const current = resource(saved.key, saved.kind);
      if (current.externalId !== saved.externalId || current.purpose !== saved.purpose) throw new Error("Retained development boundary resource changed");
    }
    const source = Source.parse(await local(config.source.file, config.source.sha256)); identity(source);
    const compose = resource(source.composeKey, "docker-compose"), composeMetadata = object(compose.metadata), project = Text.parse(composeMetadata.project);
    const mysql = resource(source.containerKey, "docker-container"), volume = resource(source.volumeKey, "docker-volume"), old = resource(config.workspace.resourceKey, "docker-container");
    if (object(mysql.metadata).manifest !== compose.externalId || object(mysql.metadata).service !== "mysql" || object(volume.metadata).manifest !== compose.externalId
      || old.externalId !== config.workspace.originalId || object(old.metadata).manifest !== compose.externalId || object(old.metadata).image !== config.workspace.image
      || new Set([app.externalId, mysql.externalId, old.externalId, config.workspace.id]).size !== 4) throw new Error("Retained development original source or workspace changed");
    const protect = (value: Resource, service: string) => {
      if (value.id === app.id || !/^[a-f0-9]{64}$/.test(value.externalId)) throw new Error("Retained development source overlaps its current app");
      resourceIds.add(value.id!); containers.set(value.externalId, { id: value.externalId, state: "stopped", image: Text.parse(object(value.metadata).image), project, service });
    };
    const endpoints = Object.values(config.endpoints);
    if (!equal(sorted(retained.dataResourceKeys), sorted(endpoints.map(value => value.binding.resourceKey))) || !equal(sorted(state.boundary.targetIds), sorted(endpoints.map(value => value.binding.resourceId)))
      || new Set(transfer.stores.map(value => value.name)).size !== 3) throw new Error("Retained development target membership changed");
    for (const [name, endpoint] of Object.entries(config.endpoints)) {
      const stores = transfer.stores.filter(value => value.name === name && value.targetId === endpoint.binding.resourceId && value.targetFile === endpoint.file && value.targetSha256 === endpoint.sha256 && equal(value.targetBinding, endpoint.binding));
      if (stores.length !== 1) throw new Error("Retained development migration endpoint changed");
      const store = stores[0]!, target = resource(endpoint.binding.resourceKey, name === "mysql" ? "planetscale-branch" : "neon-branch-database");
      if (target.externalId !== endpoint.binding.resourceId) throw new Error("Retained development target identity changed");
      const targetMetadata = object(target.metadata);
      if (name === "mysql") {
        if (endpoint.binding.provider !== "planetscale" || store.mode !== "copy" || store.sourcePreparation !== "stopped-mysql" || store.sourceId !== mysql.externalId
          || store.sourceBinding?.resourceKey !== mysql.key || store.sourceBinding.provider !== "docker" || store.sourceBinding.resourceId !== mysql.externalId
          || store.sourceFile !== config.source.file || store.sourceSha256 !== config.source.sha256 || !equal(state.boundary.sourceIds, [mysql.externalId])
          || targetMetadata.sourceDigest !== config.sourceDigest || targetMetadata.configurationFile !== endpoint.binding.recipeFile || targetMetadata.configurationSha256 !== endpoint.binding.recipeSha256
          || object(targetMetadata.provider).id !== target.externalId) throw new Error("Retained development MySQL copy correspondence changed");
        const targetConfig = Identity.extend({ sourceConfigurationFile: Absolute, sourceConfigurationSha256: Hash, key: Text }).parse(await local(Absolute.parse(targetMetadata.configurationFile), Hash.parse(targetMetadata.configurationSha256)));
        identity(targetConfig);
        if (targetConfig.key !== target.key || targetConfig.sourceConfigurationFile !== config.source.file || targetConfig.sourceConfigurationSha256 !== config.source.sha256) throw new Error("Retained development MySQL source pin changed");
        protect(mysql, "mysql");
      } else {
        if (endpoint.binding.provider !== "neon" || store.mode !== "reuse-target" || !store.provenance || targetMetadata.reconciliationVersion !== 1 || targetMetadata.composeResourceId !== compose.id || targetMetadata.sourceProject !== project
          || !equal(Provenance.parse(targetMetadata), store.provenance) || targetMetadata.cutoverReceipt !== store.provenance.receiptFile) throw new Error("Retained development Neon provenance changed");
        const cutover = Cutover.parse(await local(store.provenance.receiptFile, store.provenance.receiptSha256));
        const mappings = z.array(z.unknown()).max(256).parse(await local(store.provenance.mappingFile, store.provenance.mappingSha256));
        const database = target.externalId.split("/");
        if (database.length !== 2 || cutover.branchId !== database[0] || cutover.project !== project || !cutover.containers.some(value => value.id === old.externalId && value.service === "workspace")) throw new Error("Retained development cutover scope changed");
        const matching = mappings.filter(value => { const entry = value as Record<string, unknown>; return entry?.taskId === task.id && entry?.purpose === "development" && entry?.branchId === database[0]; });
        if (matching.length !== 1) throw new Error("Retained development database mapping is ambiguous");
        const mapping = Mapping.parse(matching[0]), spatial = task.resources.find(value => value.id === targetMetadata.sourceResourceId);
        if (!spatial || spatial !== resource(spatial.key, "docker-container") || spatial.externalId !== mapping.sourceId || mapping.project !== project || mapping.worktree !== task.worktreePath
          || !mapping.composeFiles.includes(compose.externalId) || mapping.copy.filter(value => value.database === database[1]).length !== 1 || object(spatial.metadata).manifest !== compose.externalId || object(spatial.metadata).service !== "spatial") throw new Error("Retained development original spatial source changed");
        protect(spatial, "spatial");
      }
    }
    resourceIds.add(old.id!); containers.set(old.externalId, { id: old.externalId, state: "absent", image: config.workspace.image, project });
    containers.set(config.workspace.id, { id: config.workspace.id, state: "stopped", image: config.workspace.image, createdAt: config.workspace.createdAt, project, service: "workspace" });
    for (const id of [app.externalId, ...containers.keys()]) {
      const aliases = task.resources.filter(value => value.externalId === id && value.state !== "released");
      if (aliases.length > 1 || aliases.some(value => value.kind !== "docker-container" || value.purpose !== "development")
        || id === config.workspace.id && aliases.length) throw new Error("Retained development physical container has another resource claim");
    }
  }
  return { resourceIds: [...resourceIds].sort(), containers: [...containers.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}
