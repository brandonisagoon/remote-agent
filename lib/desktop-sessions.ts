import { z } from "zod";

export const SessionSummarySchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  machineId: z.string(),
  name: z.string().nullable(),
  status: z.string(),
  role: z.string().nullable(),
  agentCommand: z.string(),
  cwd: z.string(),
  worktreePath: z.string().nullable(),
  updatedAt: z.string(),
  labels: z.array(z.object({ key: z.string(), value: z.string(), source: z.string() })).default([]),
  resourceLinks: z.array(z.object({
    provider: z.string(), connectionId: z.string(), resourceType: z.string(),
    externalId: z.string(), relationship: z.string(), endedAt: z.string().nullable(),
  })).default([]),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const DesktopRepositoryReferenceSchema = z.object({
  machineId: z.string().min(1),
  repositoryId: z.string().min(1),
  origin: z.string().min(1).nullable(),
}).strict();
export type DesktopRepositoryReference = z.infer<typeof DesktopRepositoryReferenceSchema>;

export const MachineSessionsSchema = z.object({
  machineId: z.string(),
  sessions: z.array(SessionSummarySchema),
});
export type MachineSessions = z.infer<typeof MachineSessionsSchema>;

/** Compare network repositories without exposing embedded credentials. Local
 * paths identify only a checkout on one machine, never a cross-machine repo. */
export function canonicalGitOrigin(remote: string): string | null {
  const value = remote.trim();
  if (/^[A-Za-z]:[\\/]/.test(value)) return null;
  const scp = /^(?:[^/@:]+@)?([^/:]+):(.+)$/.exec(value);
  const address = !value.includes("://") && scp ? `ssh://${scp[1]}/${scp[2]}` : value;
  try {
    const url = new URL(address);
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return null;
    let repository = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    if (!repository || url.hostname.length < 1) return null;
    if (url.hostname === "github.com") repository = repository.toLowerCase();
    const port = url.protocol === "ssh:" && url.port === "22" ? "" : url.port;
    return `${url.hostname.toLowerCase()}${port ? `:${port}` : ""}/${repository}`;
  } catch { return null; }
}

export interface MachineSessionSnapshot {
  hostId: string;
  machineName: string;
  data?: MachineSessions;
  unavailable: boolean;
}

export function combineMachineSessions(snapshots: MachineSessionSnapshot[]) {
  const rows = new Map<string, SessionSummary & { hostId: string; machineName: string; unavailable: boolean }>();
  for (const snapshot of snapshots) {
    for (const session of snapshot.data?.sessions ?? []) {
      const key = `${session.machineId}:${session.id}`;
      const previous = rows.get(key);
      // Two profiles can point at one machine. Prefer a fresh observation.
      if (previous && (!previous.unavailable || snapshot.unavailable)) continue;
      rows.set(key, { ...session, hostId: snapshot.hostId, machineName: snapshot.machineName, unavailable: snapshot.unavailable });
    }
  }
  return [...rows.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.machineId.localeCompare(b.machineId) || a.id.localeCompare(b.id));
}
