import path from "node:path";
import { z } from "zod";

type Resource = { id?: string; key: string; kind: string; purpose: string; state: string; externalId: string; metadata?: unknown };
export const neonReviewWriterKinds = new Set(["task-runtime", "native-app", "local-http", "local-process", "launch-agent", "launch-agents", "docker-compose", "docker-compose-project", "docker-container"]);
/** Only the explicit disposable review database. A migrated development
 * database is provenance for the shared branch, never a deletion target. */
export function legacyNeonReviewScope(task: { id: string; resources: Resource[] }, resource: Resource) {
  const meta = z.record(z.string(), z.unknown()).parse(resource.metadata ?? {});
  const match = /^(br-[a-z0-9-]+)\/([a-z][a-z0-9_]{0,62})$/.exec(resource.externalId);
  if (!resource.id || resource.kind !== "neon-branch-database" || resource.purpose !== "review" || !match
    || resource.key !== "spatial-neon-review" || meta.database !== match[2] || meta.owner !== "drafted_runtime"
    || meta.release !== `DROP DATABASE ${match[2]} after review services stop`
    || ["shared", "preserve", "preserved", "retained"].some(key => meta[key] !== undefined && meta[key] !== false)) throw new Error("An explicit disposable original review database is required");
  const env = z.string().parse(meta.env).replace(/ \(0600\)$/, "");
  if (!path.isAbsolute(env) || path.normalize(env) !== env || path.basename(env) !== "spatial.env"
    || path.basename(path.dirname(env)) !== `${task.id}-review` || path.basename(path.dirname(path.dirname(env))) !== "environments") throw new Error("Review database environment does not belong to the original task");
  const sources = task.resources.filter(value => value.kind === "neon-branch-database" && value.key === "spatial-neon-development" && value.purpose === "development" && value.externalId === `${match[1]}/task_spatial`);
  if (sources.length !== 1 || !sources[0]!.id || sources[0]!.state !== "ready" || match[2] === "task_spatial" || match[2] === "studio_spatial_test" || match[2] === "studio_spatial") throw new Error("Review database has no exact preserved migration source");
  const source = sources[0]!, sourceMeta = z.record(z.string(), z.unknown()).parse(source.metadata ?? {});
  const cutover = z.string().parse(sourceMeta.cutoverReceipt), project = `drafted-${task.id}-development`;
  if (!path.isAbsolute(cutover) || path.normalize(cutover) !== cutover || path.basename(cutover) !== "receipt.private.json"
    || path.basename(path.dirname(cutover)) !== project || path.basename(path.dirname(path.dirname(cutover))) !== "cutovers"
    || sourceMeta.runtimeDatabase !== "task_spatial") throw new Error("Review database has no exact original cutover receipt");
  if (task.resources.some(value => value.id !== resource.id && value.externalId === resource.externalId)) throw new Error("Review database has another registered alias");
  if (task.resources.some(value => value.purpose === "review" && neonReviewWriterKinds.has(value.kind) && value.state !== "released")) throw new Error("Registered review database consumers are not retired");
  return { branchId: match[1]!, database: match[2]!, role: meta.owner as string, env, source, project, cutover,
    mapping: path.join(path.dirname(path.dirname(path.dirname(cutover))), "branches.private.json") };
}
