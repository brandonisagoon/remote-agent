/**
 * DRA-37 test-only synthetic PlanetScale management API, loaded into each
 * committed Drafted CLI process by `bun --no-env-file --preload <this file>
 * <release checkout>/src/cli.ts runtime ...`. Drafted's CLI, operation
 * guards, runtime, transports and observer code run unchanged.
 *
 * ONLY `https://api.planetscale.com` is intercepted, at the fetch layer (no
 * CONNECT proxy, TLS or CA). Nothing addressed to it ever reaches the
 * network: no request, header or credential is forwarded. Requests are
 * answered only for this exact scripted operation set, against the scripted
 * organization/database/base branch, with the exact scripted synthetic
 * Authorization value and redirect "error"; anything else is refused (logged,
 * then thrown as a fetch failure, which Drafted reports as a failed remote
 * dependency request):
 *   GET  …/branches/<base>              the pinned ready production base
 *   GET  …/branches/<name>              404 until created, then that branch
 *   POST …/branches                     create <name> from <base> (ready)
 *   POST …/branches/<name>/passwords    synthetic admin/readwriter password
 *   DELETE …/branches/<name>/passwords/<id>  only an admin password this
 *                                       transport issued for that branch, once
 * Unix-socket and loopback requests keep the original fetch; every other
 * outbound external host is refused (logged and thrown), never forwarded.
 *
 * Private files in DRA37_PLANETSCALE_DIRECTORY (shared by every CLI process
 * of one rehearsal, so A's branch is visible to B's later resume):
 *   planetscale-state.json      scripted by the runner (read-only here)
 *   planetscale-branches.jsonl  branches this transport created (append-only)
 *   planetscale-passwords.jsonl passwords issued/deleted (IDs and roles only)
 *   planetscale-requests.jsonl  every intercepted/observed request and outcome
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const directory = process.env.DRA37_PLANETSCALE_DIRECTORY;
if (!directory || !path.isAbsolute(directory)) throw new Error("The DRA-37 synthetic PlanetScale preload requires an absolute DRA37_PLANETSCALE_DIRECTORY");
const statePath = path.join(directory, "planetscale-state.json");
const branchesPath = path.join(directory, "planetscale-branches.jsonl");
const requestLog = path.join(directory, "planetscale-requests.jsonl");

const Identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,150}$/);
const State = z.strictObject({ organization: Identifier, database: Identifier, baseBranch: Identifier, baseBranchId: Identifier,
  authorization: z.string().regex(/^synthetic-not-a-credential-[^:\s]+:synthetic-not-a-credential-[^:\s]+$/) });
const Branch = z.strictObject({ id: Identifier, name: Identifier, parent_branch: Identifier, ready: z.literal(true), production: z.literal(false), safe_migrations: z.literal(false), createdAt: z.string() });
const state = State.parse(JSON.parse(readFileSync(statePath, "utf8")));
const base = `https://api.planetscale.com/v1/organizations/${encodeURIComponent(state.organization)}/databases/${encodeURIComponent(state.database)}`;
const log = (value: object) => appendFileSync(requestLog, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...value }) + "\n", { mode: 0o600 });
const passwordsPath = path.join(directory, "planetscale-passwords.jsonl");
const Password = z.strictObject({ id: z.string(), branch: Identifier, role: z.enum(["admin", "readwriter"]), event: z.enum(["issued", "deleted"]) });
const passwords = (): z.infer<typeof Password>[] => existsSync(passwordsPath) ? readFileSync(passwordsPath, "utf8").split("\n").filter(Boolean).map(line => Password.parse(JSON.parse(line))) : [];
function appendDurable(file: string, value: object) {
  const descriptor = openSync(file, "a", 0o600);
  try { writeSync(descriptor, JSON.stringify(value) + "\n"); fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
const branches = (): z.infer<typeof Branch>[] => existsSync(branchesPath) ? readFileSync(branchesPath, "utf8").split("\n").filter(Boolean).map(line => Branch.parse(JSON.parse(line))) : [];
const appendBranch = (branch: z.infer<typeof Branch>) => appendDurable(branchesPath, branch);
const wire = (branch: z.infer<typeof Branch>) => ({ id: branch.id, name: branch.name, parent_branch: branch.parent_branch, ready: branch.ready, production: branch.production, safe_migrations: branch.safe_migrations });
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

const original = globalThis.fetch;
const synthetic = async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname !== "api.planetscale.com") {
    // Unix-socket (control socket; arbitrary host, `unix` option) and
    // loopback requests are unchanged. Any other outbound external host is
    // refused, never forwarded with a synthetic or real credential.
    const unix = Boolean(init && (init as { unix?: string }).unix);
    if (unix || LOOPBACK.has(url.hostname)) return original(input as Parameters<typeof fetch>[0], init);
    log({ outcome: "refused-external", method: request.method, origin: url.origin });
    throw new TypeError(`DRA-37 synthetic transport refused unexpected outbound host ${url.hostname}`);
  }
  const refuse = (reason: string): never => {
    log({ outcome: "refused", reason, method: request.method, path: url.pathname });
    throw new TypeError(`DRA-37 synthetic PlanetScale refused ${reason}`);
  };
  if (url.protocol !== "https:" || url.search || url.hash) refuse("non-exact URL");
  if (request.headers.get("authorization") !== state.authorization) refuse("unexpected credential");
  if (request.redirect !== "error") refuse("redirects must be refused by the caller");
  if (!url.href.startsWith(`${base}/`)) refuse("unscripted organization or database");
  const suffix = url.href.slice(base.length);
  const body = request.method === "POST" ? await request.json().catch(() => refuse("non-JSON body")) as Record<string, unknown> : undefined;
  const answer = (status: number, value: unknown, operation: string, detail: object = {}) => {
    log({ outcome: "answered", operation, status, method: request.method, path: url.pathname, ...detail });
    return status === 404 ? new Response("{}", { status, headers: { "content-type": "application/json" } }) : Response.json(value, { status });
  };
  let match: RegExpExecArray | null;
  if (request.method === "GET" && (match = /^\/branches\/([^/]+)$/.exec(suffix))) {
    const name = Identifier.parse(decodeURIComponent(match[1]!));
    if (name === state.baseBranch) return answer(200, { id: state.baseBranchId, name, parent_branch: null, ready: true, production: true, safe_migrations: true }, "read-base");
    const branch = branches().find(value => value.name === name);
    return branch ? answer(200, wire(branch), "read-branch", { branch: branch.id }) : answer(404, null, "read-branch-absent", { name });
  }
  if (request.method === "POST" && suffix === "/branches") {
    const input = z.strictObject({ name: Identifier, parent_branch: z.literal(state.baseBranch) }).safeParse(body);
    if (!input.success) return refuse("unexpected branch request");
    if (input.data.name === state.baseBranch || branches().some(value => value.name === input.data.name)) return refuse("branch already exists");
    const branch = { id: `dra37-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`, name: input.data.name, parent_branch: state.baseBranch, ready: true as const, production: false as const, safe_migrations: false as const, createdAt: new Date().toISOString() };
    appendBranch(branch);
    return answer(201, wire(branch), "create-branch", { branch: branch.id, name: branch.name });
  }
  if (request.method === "POST" && (match = /^\/branches\/([^/]+)\/passwords$/.exec(suffix))) {
    const branch = branches().find(value => value.name === decodeURIComponent(match![1]!));
    if (!branch) return refuse("password for an unknown branch");
    const input = z.union([z.strictObject({ name: z.literal("drafted-admin"), role: z.literal("admin"), ttl: z.literal(3600) }),
      z.strictObject({ name: z.literal("drafted-readwriter"), role: z.literal("readwriter") })]).safeParse(body);
    if (!input.success) return refuse("unexpected password request");
    // Synthetic, non-routable identity: nothing connects to it (the fixture
    // product's schema tool only records that a URL was supplied).
    const id = `dra37pw${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    appendDurable(passwordsPath, { id, branch: branch.name, role: input.data.role, event: "issued" });
    return answer(201, { id, role: input.data.role, username: `dra37-synthetic-${input.data.role}`,
      plain_text: `synthetic-not-a-password-${crypto.randomUUID()}`, access_host_url: "dra37-synthetic-not-a-host.psdb.cloud", database_branch: { id: branch.id, name: branch.name } },
      "create-password", { branch: branch.id, role: input.data.role });
  }
  if (request.method === "DELETE" && (match = /^\/branches\/([^/]+)\/passwords\/([^/]+)$/.exec(suffix))) {
    const name = decodeURIComponent(match[1]!), id = decodeURIComponent(match[2]!), history = passwords().filter(value => value.id === id);
    if (!history.some(value => value.event === "issued" && value.branch === name && value.role === "admin")) return refuse("deletion of a password this transport did not issue as admin for that branch");
    if (history.some(value => value.event === "deleted")) return refuse("password already deleted");
    appendDurable(passwordsPath, { id, branch: name, role: "admin", event: "deleted" });
    log({ outcome: "answered", operation: "delete-admin-password", status: 204, method: request.method, path: url.pathname });
    return new Response(null, { status: 204 });
  }
  return refuse("unscripted operation");
};
globalThis.fetch = Object.assign(synthetic, { preconnect: original.preconnect }) as typeof fetch;
log({ outcome: "loaded", argv: process.argv.slice(1, 4) });
