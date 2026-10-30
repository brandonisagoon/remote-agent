import path from "node:path";
import { z } from "zod";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";

const Fields = z.enum(["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "OPENAI_API_KEY", "MAPBOX_TOKEN", "VITE_MAPBOX_TOKEN", "NEXT_PUBLIC_MAPBOX_TOKEN", "REALIE_API_KEY", "ZONEOMICS_API_KEY", "GOOGLE_STREET_VIEW_API_KEY", "TERRAIN_REGISTRY_DATABASE_URL", "HOME_STUDIO_CHAT_MODEL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]);
const derived = ["clerk.env", "provider.env", "web-provider.env", "terrain.src.env", "api.env", "web.env", "spatial.env", "test.env"];
type Resource = { id?: string; key: string; kind: string; purpose: string; externalId: string; state: string; metadata?: unknown; expiresAt?: string | null };
type ScopeTask = { id: string; worktreePath: string; toolingRevision: string; pinnedToolingRoot?: string | null; resources: Resource[] };
export const exportContains = (root: string, file: string) => root === file || file.startsWith(root + path.sep);

/** The exact old export recipe, not a generic private-file or pathname grant. */
export function legacyPrivateExportScope(task: ScopeTask, key: string) {
  const resource = task.resources.find(value => value.key === key);
  if (!resource?.id || resource.kind !== "private-file" || resource.purpose !== "development" || key !== "credentials-export-development") throw new Error("An exact original development credential export is required");
  const source = resource.externalId, environment = path.dirname(source);
  if (!path.isAbsolute(source) || path.normalize(source) !== source || source.includes("\0") || path.basename(source) !== "provider.src.env"
    || path.basename(environment) !== task.id || path.basename(path.dirname(environment)) !== "environments") throw new Error("Credential export is outside its exact task environment");
  const metadata = z.object({ source: z.string(), fields: z.array(Fields).min(1).max(13), derivedFiles: z.array(z.string()).length(8) }).passthrough().parse(resource.metadata);
  const createdAt = /^pinned tooling credentials\/development\.enc\.json \(createdAt (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)\), authenticated$/.exec(metadata.source)?.[1];
  if (!createdAt || !Number.isFinite(Date.parse(createdAt)) || new Set(metadata.fields).size !== metadata.fields.length
    || finalizationDigest([...metadata.derivedFiles].sort()) !== finalizationDigest([...derived].sort())) throw new Error("Credential export has an unsupported original backup recipe");
  const groups = task.resources.filter(value => value.state !== "released" && value.kind === "docker-compose-project" && value.purpose === "development"
    && value.externalId === `drafted-${task.id}-development` && (value.metadata as { envDirectory?: unknown } | null)?.envDirectory === environment
    && (value.metadata as { composeFile?: unknown } | null)?.composeFile === path.join(environment, "compose.yml"));
  if (groups.length !== 1 || !groups[0]!.id) throw new Error("Credential export has no exact original environment association");
  const pinned = task.pinnedToolingRoot;
  if (!pinned || !path.isAbsolute(pinned) || path.normalize(pinned) !== pinned || !/^[a-f0-9]{40}$/.test(task.toolingRevision)) throw new Error("Credential export requires its original pinned tooling backup");
  const identity = finalizationResourceIdentity({ ...resource, id: resource.id });
  const token = finalizationDigest({ taskId: task.id, resource: identity });
  const storage = path.join(path.dirname(environment), `.drafted-private-export-${token}`);
  const plan = path.join(storage, "plan.json"), directory = path.join(storage, "capture");
  const protectedPaths = [task.worktreePath, pinned, ...task.resources.filter(value => value.id !== resource.id && path.isAbsolute(value.externalId)).map(value => value.externalId)];
  if (protectedPaths.some(file => exportContains(file, storage) || exportContains(storage, file))
    || task.resources.some(value => value.id !== resource.id && value.externalId === source)) throw new Error("Credential export recovery overlaps another resource or retained root");
  return { resource, group: groups[0]!, source, environment, storage, plan, quarantine: { directory, path: path.join(directory, "contents"), journal: path.join(directory, "pending.json") },
    backupFile: path.join(pinned, "credentials/development.enc.json"), pinnedToolingRoot: pinned, createdAt, fields: metadata.fields, derivedFiles: metadata.derivedFiles };
}
