import { z } from "zod";
import type { RetirementBinding } from "./retirement-receipts.ts";

type Resource = RetirementBinding["resources"][number];
const kinds = ["cloudflare-tunnel", "cloudflare-dns-record", "cloudflare-dns-route"];
const Hex = z.string().regex(/^[a-f0-9]{32}$/i), UUID = z.string().regex(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i);
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function host(resource: Resource) {
  const metadata = object(resource.metadata), tunnel = object(metadata.publicTunnel);
  const value = metadata.publicUrl ?? metadata.hostname ?? tunnel.hostname ?? (kinds.includes(resource.kind) && /^[a-z0-9.-]+\.[a-z]+$/i.test(resource.externalId) ? resource.externalId : null);
  try { return typeof value === "string" ? new URL(value.startsWith("http") ? value : `https://${value}`).hostname : undefined; } catch { return undefined; }
}
function activePreview(resource: Resource) { return resource.state !== "released" && (kinds.includes(resource.kind) || resource.kind === "local-http" && Boolean(object(resource.metadata).publicUrl)); }
function previewScope(resource: Resource, resources: Resource[]) {
  const metadata = object(resource.metadata), hostname = host(resource);
  if (!hostname) throw new Error("Retirement preview requires a recorded hostname");
  if (hostname.endsWith(".trycloudflare.com")) {
    const keys = z.array(z.string().min(1)).min(1).parse(metadata.connectorKeys);
    if (new Set(keys).size !== keys.length || keys.some(key => !resources.some(item => item.key === key && item.purpose === resource.purpose && ["launch-agent", "docker-container"].includes(item.kind)))) throw new Error("Retirement quick preview requires exact connector identities");
    return { kind: "quick" as const, hostname, keys };
  }
  const tunnelId = UUID.parse(metadata.tunnelId), zoneId = Hex.parse(metadata.zoneId), dnsRecordId = Hex.nullable().parse(metadata.dnsRecordId);
  if (metadata.hostname !== hostname || object(metadata.publicTunnel).id !== undefined && object(metadata.publicTunnel).id !== tunnelId) throw new Error("Retirement preview canonical identities conflict");
  const related = resources.filter(item => host(item) === hostname || !host(item) && kinds.includes(item.kind) && object(item.metadata).tunnelId === tunnelId);
  const endpoint = related.find(item => item.kind === "local-http"), tunnel = related.find(item => item.kind === "cloudflare-tunnel");
  const publicTunnel = object(object(endpoint?.metadata).publicTunnel), tunnelMeta = object(tunnel?.metadata);
  const shared = publicTunnel.shared === true || tunnelMeta.shared === true || !tunnel && publicTunnel.shared !== false;
  if (!shared) Hex.parse(metadata.accountId);
  if (related.some(item => activePreview(item) && (object(item.metadata).tunnelId !== tunnelId || object(item.metadata).zoneId !== zoneId || object(item.metadata).dnsRecordId !== dnsRecordId))) throw new Error("Retirement preview identities differ within one hostname");
  return { kind: "named" as const, hostname, tunnelId, zoneId, dnsRecordId, shared, related };
}

/** Discovery and legacy receipt expansion must finish before owner authority
 * freezes the set. The inspection adapter performs GETs and registry writes. */
export function assertRetirementResourcePreflight(resources: Resource[]) {
  for (const resource of resources.filter(item => item.state !== "released")) {
    const metadata = object(resource.metadata);
    if (resource.kind === "launch-agent" && (typeof metadata.manifest !== "string" || !/^[a-f0-9]{64}$/.test(String(metadata.sha256 ?? "")))) throw new Error("Reconcile legacy launch-agent ownership before retirement authorization");
    if (resource.kind === "launch-agents") {
      const members = z.array(z.object({ key: z.string(), label: z.string(), manifest: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).min(1).safeParse(metadata.members);
      const labels = z.array(z.string()).min(1).safeParse(metadata.labels);
      if (metadata.compatibility !== "drafted.cleanup/v1" || !members.success || !labels.success || new Set(labels.data).size !== labels.data.length || members.data.length !== labels.data.length
        || members.data.some(member => member.key !== `${resource.key}:${member.label}` || !labels.data.includes(member.label) || !resources.some(item => item.key === member.key && item.kind === "launch-agent" && item.purpose === resource.purpose && item.externalId === member.label
          && object(item.metadata).manifest === member.manifest && object(item.metadata).sha256 === member.sha256 && object(item.metadata).group === resource.key && object(item.metadata).compatibility === "drafted.cleanup/v1"))) throw new Error("Reconcile legacy launch-group ownership before retirement authorization");
    }
    if (activePreview(resource)) {
      try {
        if (object(metadata.publicPreviewCleanup).complete === true) throw new Error("Conflicting preview completion");
        previewScope(resource, resources);
      } catch { throw new Error("Reconcile exact public preview identities before retirement authorization"); }
    }
  }
}

/** Permit only the adapter's terminal annotations for the already frozen
 * target. IDs, credentials, paths, aliases and all other metadata stay exact. */
export function normalizeRetirementPreviewTransition(saved: Resource, current: Resource, savedResources: Resource[], currentResources: Resource[]) {
  const before = object(saved.metadata), after = { ...object(current.metadata) };
  if (!activePreview(saved)) return current.metadata;
  const scope = previewScope(saved, savedResources);
  if (after.cleanupObserved !== before.cleanupObserved) {
    const allowed = saved.kind === "cloudflare-tunnel" && scope.kind === "named" ? scope.shared ? "task-hostname-removed-shared-tunnel-preserved" : "exact-tunnel-absent"
      : ["cloudflare-dns-record", "cloudflare-dns-route"].includes(saved.kind) ? "exact-dns-record-absent" : null;
    if (!allowed || after.cleanupObserved !== allowed || current.state !== "released" || before.cleanupObserved !== undefined) throw new Error("Retirement preview cleanup observation changed");
    delete after.cleanupObserved;
  }
  if (typeof before.publicUrl === "string" && after.publicUrl === null) {
    if (saved.kind !== "local-http" || before.publicPreviewCleanup !== undefined) throw new Error("Retirement preview completion is inconsistent");
    const common = z.object({ complete: z.literal(true), hostname: z.literal(scope.hostname), observedAt: z.iso.datetime() });
    if (scope.kind === "quick") {
      common.extend({ quickTunnelConnectorRemoved: z.literal(true) }).strict().parse(after.publicPreviewCleanup);
      if (scope.keys.some(key => currentResources.find(item => item.key === key)?.state !== "released")) throw new Error("Retirement quick preview connector is not released");
    } else {
      common.extend({ tunnelId: z.literal(scope.tunnelId), sharedTunnelPreserved: z.literal(scope.shared) }).strict().parse(after.publicPreviewCleanup);
      if (scope.related.some(item => kinds.includes(item.kind) && currentResources.find(current => current.id === item.id)?.state !== "released")) throw new Error("Retirement preview provider receipt is not released");
    }
    after.publicUrl = before.publicUrl;
    delete after.publicPreviewCleanup;
  }
  return after;
}
