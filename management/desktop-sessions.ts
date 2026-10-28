import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { readConfigDocument } from "../lib/config-file.ts";
import type { ServiceFile } from "../lib/config.ts";
import { canonicalGitOrigin, SessionSummarySchema, type DesktopRepositoryReference, type MachineSessions } from "../lib/desktop-sessions.ts";
import { desktopControl } from "./desktop-control.ts";
import { chatgptReviewForSession } from "../lib/chatgpt-review.ts";

function sessionConfig(file: string): ServiceFile {
  const document = readConfigDocument(file);
  if (!document.valid) throw new Error("Machine configuration needs attention before reading sessions");
  return document.value;
}

function absoluteHostPath(value: string, file: string) {
  return value.startsWith("~") ? path.join(os.homedir(), value.slice(1)) : path.resolve(path.dirname(file), value);
}

async function repositoryOrigin(file: string, root: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", absoluteHostPath(root, file), "config", "--get", "remote.origin.url"], { encoding: "utf8", timeout: 2000, maxBuffer: 16_384 }, (error, stdout) => {
      resolve(error ? null : canonicalGitOrigin(stdout));
    });
  });
}

export async function desktopRepositoryReference(file: string, repositoryId: string): Promise<DesktopRepositoryReference> {
  const config = sessionConfig(file);
  const repository = config.repositories[repositoryId];
  if (!repository) throw new Error("Repository is not configured on this machine");
  return { machineId: config.machine.id, repositoryId, origin: await repositoryOrigin(file, repository.root) };
}

/** Read only repositories with the same origin, even when their local IDs and
 * names differ. Never match by display name or by another machine's opaque ID. */
export async function desktopRepositorySessions(file: string, reference: DesktopRepositoryReference): Promise<MachineSessions> {
  const config = sessionConfig(file);
  const candidates = await Promise.all(Object.entries(config.repositories).map(async ([id, repository]) => ({
    id, origin: await repositoryOrigin(file, repository.root),
  })));
  const repositoryIds = candidates.filter((candidate) => {
    if (reference.origin) return candidate.origin === reference.origin;
    return config.machine.id === reference.machineId && candidate.id === reference.repositoryId;
  }).map((candidate) => candidate.id);
  if (!repositoryIds.length) return { machineId: config.machine.id, sessions: [] };

  async function readSessionApi(route: string): Promise<unknown> {
    const server = config.machine.server;
    if (server.controlSocketPath) {
      return desktopControl(absoluteHostPath(server.controlSocketPath, file), route, "GET", undefined, 4000);
    }
    const { host, port } = server.listen;
    const response = await fetch(`http://${host}:${port}${route}`, {
      headers: { authorization: `Bearer ${server.apiKey}` }, signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error(`Session API returned ${response.status}`);
    return response.json();
  }
  // Older hosts can list sessions without supporting task previews.
  const tasks = await readSessionApi("/api/tasks").catch(() => null);
  const results = await Promise.all(repositoryIds.map(async (repositoryId) => {
    const body = await readSessionApi(`/api/sessions?includeClosed=true&repositoryId=${encodeURIComponent(repositoryId)}`);
    const parsed = SessionSummarySchema.array().safeParse((body as { sessions?: unknown })?.sessions);
    if (!parsed.success) throw new Error("Machine returned an invalid session list");
    if (parsed.data.some((session) => session.repositoryId !== repositoryId || session.machineId !== config.machine.id)) {
      throw new Error("Session response does not match the requested repository and machine");
    }
    return parsed.data.map((session) => ({ ...session, chatgptReview: chatgptReviewForSession(session, tasks) }));
  }));
  return { machineId: config.machine.id, sessions: results.flat() };
}
