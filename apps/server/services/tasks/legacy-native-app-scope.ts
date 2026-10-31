import path from "node:path";
import { z } from "zod";

type Resource = { id?: string; key: string; kind: string; purpose: string; externalId: string; state: string; expiresAt?: string | null; metadata?: unknown };
const object = (value: unknown) => z.record(z.string(), z.unknown()).parse(value ?? {});
const pid = z.number().int().positive();
const absolute = z.string().refine(value => path.isAbsolute(value) && path.normalize(value) === value && !value.includes("\0"));
const address = (value: unknown, protocol = false) => {
  const text = z.string().parse(value), match = (protocol ? /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):([1-9]\d*)(?:\/health)?$/ : /^(127\.0\.0\.1|localhost|\[::1\]):([1-9]\d*)$/).exec(text);
  if (!match || Number(match[2]) > 65535) throw new Error("Recorded native app has an invalid loopback address");
  return { host: match[1]!, port: Number(match[2]), url: `${protocol && text.startsWith("https:") ? "https" : "http"}://${match[1]}:${match[2]}` };
};

/** Exact historical r2/r3 association, also checked by compact authority. No
 * prose, Released flag or PID alone establishes a physical process lifetime. */
export function legacyNativeAppScope(task: { id: string; worktreePath: string; resources: Resource[] }) {
  const one = (key: string) => { const matches = task.resources.filter(value => value.key === key); if (matches.length !== 1 || !matches[0]!.id) throw new Error("Recorded native app scope is incomplete"); return matches[0]!; };
  const anchor = one("local-http-development-r3"), previous = one("local-http-development-r2"), group = one("compose-development-r2"), neon = one("spatial-neon-development");
  if ([anchor, previous].some(value => value.kind !== "local-http" || value.purpose !== "development") || group.kind !== "docker-compose-project" || group.purpose !== "development"
    || group.externalId !== `drafted-${task.id}-development` || neon.kind !== "neon-branch-database" || neon.purpose !== "development") throw new Error("Recorded native app receipt kinds changed");
  const a = object(anchor.metadata), b = object(previous.metadata), g = object(group.metadata), n = object(neon.metadata);
  if (a.supersedes !== previous.key || b.supersedes !== "local-http-development (released)" || anchor.externalId !== previous.externalId
    || n.supersedes !== `local PostGIS in ${group.key} (stopped by owner cutover; volume retained; not restarted)` || n.runtimeDatabase !== "task_spatial" || !/^br-[a-z0-9-]+\/task_spatial$/.test(neon.externalId)) throw new Error("Recorded native app association changed");
  const composeFile = absolute.parse(g.composeFile), environment = path.dirname(composeFile);
  if (path.basename(composeFile) !== "compose.yml" || path.basename(environment) !== task.id || path.basename(path.dirname(environment)) !== "environments"
    || g.envDirectory !== undefined && g.envDirectory !== environment || b.launcher !== "<envDirectory>/run.sh <api|web|posthog|proxy|worker>" || b.pidFiles !== "<envDirectory>/*.pid") throw new Error("Recorded native app environment changed");
  const old = object(b.processes), now = object(a.processes);
  const roles = ["api", "parcelWorker", "web", "flagsFixture", "proxy"] as const;
  if (Object.keys(old).sort().join() !== [...roles].sort().join() || Object.keys(now).sort().join() !== [...roles].sort().join()) throw new Error("Recorded native app membership changed");
  const sources = roles.filter(role => role !== "proxy").map(role => {
    const prior = object(old[role]), current = object(now[role]), changed = role === "api" || role === "parcelWorker";
    const field = role === "parcelWorker" ? "health" : "listen";
    if (current[field] !== prior[field] || !changed && current.pid !== undefined || changed && current.spatial !== "Neon task_spatial") throw new Error("Recorded native app endpoint changed");
    const endpoint = address(current[field], role === "parcelWorker" || role === "flagsFixture");
    return { role: role === "parcelWorker" ? "worker" as const : role === "flagsFixture" ? "posthog" as const : role, pid: pid.parse(changed ? current.pid : prior.pid), ...endpoint,
      ...(role === "web" ? { listenerPid: pid.parse(prior.listenerPid) } : {}) };
  });
  if (new Set(sources.map(value => value.pid)).size !== sources.length || new Set(sources.map(value => value.port)).size !== sources.length) throw new Error("Recorded native apps repeat a PID or endpoint");
  if (address(object(now.proxy).listen).url.replace("127.0.0.1", "localhost") !== anchor.externalId) throw new Error("Recorded native proxy association changed");
  const cutoverReceipt = absolute.parse(n.cutoverReceipt);
  if (path.basename(cutoverReceipt) !== "receipt.private.json" || path.basename(path.dirname(cutoverReceipt)) !== group.externalId || path.basename(path.dirname(path.dirname(cutoverReceipt))) !== "cutovers") throw new Error("Recorded native cutover location changed");
  return { anchor, previous, group, neon, environment, composeFile, cutoverReceipt, sources, keys: [anchor.key, previous.key, group.key, neon.key].sort() };
}
