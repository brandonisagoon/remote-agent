import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, lstat, readdir, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
export const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
export async function savedDataFixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "saved-data-"))), archive = path.join(root, "saved"); await mkdir(archive, { mode: 0o700 });
  const task = { id: "task-original", primarySessionId: "primary", worktreePath: path.join(root, "original"), toolingRevision: "a".repeat(40), phase: "waiting", finalizationVersion: 2 as const, resources: [] as any[] };
  const image = "sha256:" + "f".repeat(64), containerId = "b".repeat(64), sourceId = "c".repeat(64), volume = "saved-redis", createdAt = "2026-10-30T09:41:20Z", operation = "data-preservation-fixture";
  const labels = { "dev.drafted.task": task.id, "dev.drafted.purpose": "tooling", "dev.drafted.source-purpose": "development", "dev.drafted.operation": operation };
  const files = new Map<string, Uint8Array>();
  const json = (name: string, value: unknown) => files.set(name, Buffer.from(JSON.stringify(value)));
  json("scratch.json", { task: task.id, scratch: [{ purpose: "development", type: "redis", id: containerId, name: volume, image, sourceId, volume: { Name: volume, CreatedAt: createdAt, Labels: labels } }] });
  json("restore-verification.json", { task: task.id, originalsUnchanged: true, results: [{ purpose: "development", type: "redis", scratchId: containerId, sourceId, keyCount: 1, keys: ["saved"] }] });
  json("redis-restore-roundtrip.json", { task: task.id, roundtrips: [{ purpose: "development", containerId, restoredKeys: 1, allDumpByteHashesMatch: true, network: "none" }] });
  files.set("redis-cold.tar", Buffer.from([0, 255, 34, 65]));
  const artifacts = [...files].map(([name, bytes]) => ({ path: name, sha256: sha(bytes), bytes: bytes.length, use: "existing saved evidence" }));
  const manifest = Buffer.from(JSON.stringify({ format: "DRA-8 private preservation manifest v1", task: task.id, primarySession: task.primarySessionId, policyPin: task.toolingRevision, archiveRoot: archive, artifacts }));
  files.set("manifest.json", manifest);
  for (const [name, bytes] of files) await writeFile(path.join(archive, name), bytes, { mode: 0o600 });
  const backup = { id: "backup", key: "saved-data", kind: "directory", purpose: "tooling", externalId: archive, state: "ready", metadata: { sha256: sha(manifest), bytes: manifest.length, artifactCount: artifacts.length, operation: "historical preservation only; retained scratch running" } };
  const container = { id: "scratch-container", key: "scratch-container", kind: "docker-container", purpose: "tooling", externalId: containerId, state: "ready", metadata: { image, name: volume, sourcePurpose: "development", sourceId, operation: "historical preserved running", networkMode: "none", archiveRoot: archive, volume } };
  const volumeRecord = { id: "scratch-volume", key: "scratch-volume", kind: "docker-volume", purpose: "tooling", externalId: volume, state: "allocated", metadata: { createdAt, sourcePurpose: "development", sourceId, operation: "historical restore", containerId } };
  task.resources.push(backup, container, volumeRecord);
  const objects = { container: new Map([[containerId, { id: containerId, name: volume, createdAt, image, labels, running: true, networkMode: "none", nonVolumeMounts: 0, networks: [], volumes: [volume] }]]), volume: new Map([[volume, { id: volume, createdAt, labels }]]) };
  const effects: string[] = [];
  const docker = { inspect: async (kind: string, id: string) => structuredClone((objects as any)[kind]?.get(id) ?? null), inventory: async (kind: string) => [...((objects as any)[kind]?.values() ?? [])].map(value => structuredClone(value)), stop: async (id: string) => { effects.push(`stop:${id}`); objects.container.get(id)!.running = false; }, remove: async (kind: string, id: string) => { effects.push(`remove:${kind}:${id}`); (objects as any)[kind].delete(id); } };
  const inventory: any[] = [];
  for (const name of [".", ...(await readdir(archive)).sort()]) {
    const file = name === "." ? archive : path.join(archive, name), stat = await lstat(file);
    inventory.push({ path: name, dev: stat.dev, ino: stat.ino, mode: stat.mode, ...(name === "." ? { kind: "directory" } : { kind: "file", size: stat.size, sha256: sha(await readFile(file)) }) });
  }
  const selection = { resourceId: backup.id, manifestPath: path.join(archive, "manifest.json"), manifestSha256: sha(manifest), scratchResourceIds: [container.id, volumeRecord.id] };
  return { root, archive, task, backup, container, volumeRecord, docker, objects, effects, selection, inventory, files };
}
