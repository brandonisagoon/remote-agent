/**
 * DRA-37 committed-CLI A/B physical acceptance runner (explicit; never part of
 * the default gate — the file name is deliberately not *.test.ts).
 *
 * Releases A and B are prepared by the supported frozen helper
 * (prepareToolingRelease + verifyPreparedToolingRelease) from a private
 * `--shared` clone of the paired Drafted repository, under the private
 * repository ID `dra37-repo`. Drafted's COMMITTED CLI, operation guards,
 * runtime, Docker transports and observer run unchanged. Two test-only
 * synthetic external transports, each scoped to one exact endpoint set and
 * refusing every other outbound external host (nothing is forwarded; all
 * credentials are synthetic):
 *  - test/dra37-provider-preload.ts in each CLI process: api.planetscale.com;
 *  - test/dra37-decision-preload.ts in the server process: the compute
 *    decision request (POST api.openai.com/v1/decisions), answered
 *    `suspend-compute` once, only after arming and only when the request's
 *    own evidence (from the real collector over the real app's telemetry)
 *    proves idle; `leave-running` otherwise. Docker objects are real local
 * containers behind the fixture policy guard with exact-ID ledger cleanup.
 *
 *   transport check (no Docker, no server process):
 *     DRA37_DRAFTED_SOURCE=<drafted checkout> DRA37_RELEASE_A=<sha> DRA37_RELEASE_B=<sha> \
 *       bun test ./test/dra37-activation.rehearsal.ts -t transport
 *   physical acceptance (additionally):
 *     DRA37_REAL_DOCKER=1 DRA37_AB_ACCEPTANCE=1 [DRA37_HOLD_SECONDS=1..3600 DRA37_HOLD_FILE=<path>
 *       DRA37_HOLD_AT=after-b-activation|after-b-resume] bun test ./test/dra37-activation.rehearsal.ts -t physical
 *
 * Physical flow, all through normal server routes and the primary's own turns:
 *  1. Owner-paused control task (identity seed, paused through the owner route).
 *  2. Owner TCP activation of A (generation 1).
 *  3. Normal task launch (POST /api/tasks); the launched primary resolves its
 *     runtime capability and runs A's committed `runtime up`; the delivered
 *     compute offer is claimed by A's committed `runtime up --compute-offer`.
 *     Proves: environment, confirmed retained consumer and producer on A.
 *  4. Owner TCP activation of B (generation 2), same server PID.
 *  5. The server's physical observer keeps executing A's checkout with the
 *     producer operation (guard log cwd/operation) and keeps observing running.
 *  6. Natural idle suspension: after arming (and one ordinary app request),
 *     the server's real collector, idle attempt, decision request, decision
 *     receipt and runtime-suspended intent lead to the server-started
 *     continuation, bound through A's confirmed retained consumer and executed
 *     from A's checkout; app stopped and observed stopped; operations
 *     settled; A's retained consumer resolved. Nothing is seeded.
 *  7. Owner instruction → B's committed `runtime up` (+ offer claim) adopts the
 *     SAME environment, resource and app container IDs.
 *  8. Optional bounded hold for root's browser (released only by the hold
 *     release file or the bound; no watcher), then B's `runtime stop` and
 *     exact ledger cleanup.
 *
 * Known scope limits (recorded in evidence): owner instructions are not
 * Linear source messages (no "independent turn" release line; binding uses
 * the active selection either way); the idle decision itself is synthetic
 * (no model judgement is exercised) and the quiet period is the policy
 * minimum range (60 s) rather than the 1800 s default.
 * It is written against the intended corrected admission behaviour
 * (DRA-37 H1/H2) and must not be accepted before that fix is integrated.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dra37Server, MACHINE, REPOSITORY } from "./dra37-fixture.ts";

const PRELOAD = path.join(import.meta.dir, "dra37-provider-preload.ts");
const DECISION_PRELOAD = path.join(import.meta.dir, "dra37-decision-preload.ts");
const SOURCE = process.env.DRA37_DRAFTED_SOURCE ?? "", RELEASE_A = process.env.DRA37_RELEASE_A ?? "", RELEASE_B = process.env.DRA37_RELEASE_B ?? "";
if (!SOURCE || !/^[a-f0-9]{40}$/.test(RELEASE_A) || !/^[a-f0-9]{40}$/.test(RELEASE_B) || RELEASE_A === RELEASE_B) {
  throw new Error("The DRA-37 A/B runner requires DRA37_DRAFTED_SOURCE and two distinct exact DRA37_RELEASE_A/DRA37_RELEASE_B commits; it is not part of the default test gate");
}
const HOLD_SECONDS = process.env.DRA37_HOLD_SECONDS === undefined ? 0 : Number(process.env.DRA37_HOLD_SECONDS);
if (!Number.isInteger(HOLD_SECONDS) || HOLD_SECONDS < 0 || HOLD_SECONDS > 3_600) throw new Error("DRA37_HOLD_SECONDS must be an integer from 1 to 3600 (bounded hold)");
const HOLD_AT = process.env.DRA37_HOLD_AT ?? "after-b-resume";
if (!["after-b-activation", "after-b-resume"].includes(HOLD_AT)) throw new Error("DRA37_HOLD_AT must be after-b-activation or after-b-resume");
setDefaultTimeout(1_200_000 + HOLD_SECONDS * 1_000);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const sourceRoot = path.resolve(import.meta.dir, "..");
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const gitOut = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  if (result.exitCode) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().slice(0, 300)}`);
  return result.stdout.toString();
};
type Server = Awaited<ReturnType<typeof dra37Server>>;
/** Helpers outside test/dra37-* that this runner and its fixture import
 * directly (the server process itself is covered by HEAD + tracked diff +
 * relevant untracked files). */
const IMPORTED_HELPERS = ["test-support/db.ts", "apps/server/prisma.ts", "lib/config.ts", "lib/tooling-source.ts", "apps/server/services/tasks/tooling.ts", "types/tooling-release.ts",
  "apps/server/server.ts", "package.json", "bun.lock"];
/** Paths whose change could alter what this rehearsal executes. Anything
 * else (for example another lane's test/dra31-* files) is unrelated. */
const RELEVANT = /^(apps\/|lib\/|management\/|types\/|prisma\/|generated\/|test-support\/|test\/dra37-|package\.json$|bun\.lock$|tsconfig[^/]*\.json$|bunfig\.toml$)/;
const statusPath = (line: string) => line.slice(3).split(" -> ").at(-1)!.replace(/^"|"$/g, "");
/** Exact source provenance: Remote Agent head/status/tracked diff, every
 * DRA-37 runner/helper/guard/preload digest, imported helper digests,
 * relevant untracked file digests and each prepared release receipt. */
function provenance(server: Server) {
  const status = gitOut(sourceRoot, "status", "--porcelain=v1", "--untracked-files=all");
  const digest = (relative: string) => existsSync(path.join(sourceRoot, relative)) ? sha256(readFileSync(path.join(sourceRoot, relative))) : null;
  const files = Object.fromEntries(readdirSync(import.meta.dir).filter(name => name.startsWith("dra37-") && name.endsWith(".ts")).sort().map(name => [`test/${name}`, digest(`test/${name}`)]));
  const helpers = Object.fromEntries(IMPORTED_HELPERS.map(relative => [relative, digest(relative)]));
  const relevantUntracked = Object.fromEntries(status.split("\n").filter(line => line.startsWith("?? ")).map(statusPath).filter(relative => RELEVANT.test(relative)).sort()
    .map(relative => [relative, digest(relative)]));
  const drafted = server.drafted!;
  return { at: new Date().toISOString(), remoteAgent: { head: gitOut(sourceRoot, "rev-parse", "HEAD").trim(), status, statusDigest: sha256(status),
      trackedDiffDigest: sha256(gitOut(sourceRoot, "diff", "HEAD", "--binary")), files, helpers, relevantUntracked },
    drafted: { pairedSource: SOURCE, releases: drafted.releases.map(release => ({ ...release,
      checkoutHead: gitOut(release.checkout, "rev-parse", "HEAD").trim(), checkoutTree: gitOut(release.checkout, "rev-parse", "HEAD^{tree}").trim(),
      checkoutStatus: gitOut(release.checkout, "status", "--porcelain", "--untracked-files=normal"),
      installReceipt: existsSync(`${release.checkout}.install.json`) ? JSON.parse(readFileSync(`${release.checkout}.install.json`, "utf8")) : null })) } };
}
type Provenance = ReturnType<typeof provenance>;
/** Relevant source must be identical at start and end; any status change
 * must be confined to unrelated paths and is recorded with that reason. */
function provenanceStability(start: Provenance, end: Provenance) {
  const lines = (value: Provenance) => new Set(value.remoteAgent.status.split("\n").filter(Boolean));
  const before = lines(start), after = lines(end);
  const delta = [...[...after].filter(line => !before.has(line)).map(line => ({ change: "appeared", line })), ...[...before].filter(line => !after.has(line)).map(line => ({ change: "disappeared", line }))];
  const relevantDelta = delta.filter(entry => RELEVANT.test(statusPath(entry.line)));
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const checks = { head: same(start.remoteAgent.head, end.remoteAgent.head), trackedDiff: same(start.remoteAgent.trackedDiffDigest, end.remoteAgent.trackedDiffDigest),
    dra37Files: same(start.remoteAgent.files, end.remoteAgent.files), importedHelpers: same(start.remoteAgent.helpers, end.remoteAgent.helpers),
    relevantUntracked: same(start.remoteAgent.relevantUntracked, end.remoteAgent.relevantUntracked), draftedReleases: same(start.drafted, end.drafted),
    noRelevantStatusDelta: relevantDelta.length === 0 };
  return { stable: Object.values(checks).every(Boolean), checks, relevantDelta,
    unrelatedStatusDelta: delta.filter(entry => !RELEVANT.test(statusPath(entry.line))).map(entry => ({ ...entry,
      explanation: "Outside every path this rehearsal or its server can load (not under apps/, lib/, management/, types/, prisma/, generated/, test-support/, test/dra37-* or the package/lock/config files); another writer's lane, recorded but not part of this evidence." })) };
}
const readJsonl = (file: string) => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, any>) : [];
async function until<T>(label: string, read: () => Promise<T | null | undefined | false>, ms = 300_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await Bun.sleep(250); }
  throw new Error(`Timed out waiting for ${label}`);
}

// ---------------------------------------------------------------------------
// Transport check: Drafted's committed runtimeProviders (A and B) against the
// preload, plus direct refusal probes. No Docker, no Remote Agent server.
// ---------------------------------------------------------------------------
test("transport: committed A/B PlanetScale provider calls are answered only by the strict synthetic preload", async () => {
  const server = await dra37Server({ slots: 1, drafted: { source: SOURCE, revision: RELEASE_A, additionalRevisions: [RELEASE_B] }, cli: { preload: PRELOAD } });
  let passed = false;
  cleanups.push(() => server.cleanup({ keepEvidence: !!process.env.DRA37_KEEP_EVIDENCE || !passed }));
  const transportStart = provenance(server);
  const product = await server.prepareCliProduct();
  const credentials = JSON.parse(readFileSync(product.credentialsFile, "utf8")) as Record<string, string>;
  const recipe = JSON.parse(readFileSync(product.recipe, "utf8"));
  // The auth-free synthetic product carries no Clerk fields: only the
  // synthetic PlanetScale management token, and no runtime secrets.
  expect(Object.keys(credentials).sort()).toEqual(["STUDIO_PLANETSCALE_SERVICE_TOKEN", "STUDIO_PLANETSCALE_SERVICE_TOKEN_ID"]);
  expect(recipe.runtimeSecrets).toEqual([]);
  // Credential-free committed-code check, per release, with an EMPTY private
  // HOME: Drafted's own readRecipe accepts the recipe, and its own
  // nativeClerkPublicKey (the gate in front of runtimeClerk's trusted-backup
  // loader) finds no auth entrypoint for the exact service environment
  // runtimeValues would build (fixed keys read from that checkout's committed
  // runtime.ts, recipe/service environment, runtime secrets, provider URL).
  // Counter-check: the previous Clerk fields alone select an auth entrypoint.
  const clerkProbe = path.join(server.root, "clerk-probe.ts");
  writeFileSync(clerkProbe, `const [checkout, recipeFile] = process.argv.slice(2);
const { readRecipe } = await import(checkout + "/src/runtime-config.ts");
const { nativeClerkPublicKey } = await import(checkout + "/src/clerk-startup.ts");
const source = await Bun.file(checkout + "/src/runtime.ts").text();
const literal = /function runtimeValues\\([^)]*\\)[^{]*\\{\\s*const values: RuntimeSecrets = \\{([\\s\\S]*?)\\};/.exec(source);
if (!literal) throw new Error("runtimeValues fixed keys not found in committed runtime.ts");
const fixed = [...literal[1].matchAll(/([A-Z][A-Z0-9_]*):/g)].map(match => match[1]);
const recipe = await readRecipe(recipeFile);
const out = { fixed, services: {} };
for (const [name, service] of Object.entries(recipe.services)) {
  const environment = Object.fromEntries([...fixed, ...recipe.runtimeSecrets, ...Object.keys(recipe.environment), ...Object.keys(service.environment ?? {}), "DATABASE_URL"].map(key => [key, "synthetic"]));
  out.services[name] = { keys: Object.keys(environment).sort(), clerk: nativeClerkPublicKey(service.cwd ?? ".", service.command, environment) ?? null,
    previousFieldsClerk: nativeClerkPublicKey(service.cwd ?? ".", service.command, { ...environment, CLERK_SECRET_KEY: "sk_test_fixture", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_fixture" }) ?? null };
}
console.log(JSON.stringify(out));
`, { mode: 0o600 });
  const clerk: Record<string, unknown> = {};
  for (const release of server.drafted!.releases) {
    const home = (await import("node:fs")).mkdtempSync(path.join(server.root, "empty-home-"));
    const child = Bun.spawnSync([process.execPath, "--no-env-file", clerkProbe, release.checkout, product.recipe], { cwd: server.root, stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: process.env.TMPDIR ?? "/tmp" } });
    expect(child.exitCode, child.stderr.toString().slice(-2_000)).toBe(0);
    const out = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
    expect(out.fixed).toEqual(["NODE_ENV", "ENVIRONMENT", "DRAFTED_CONTAINER", "TZ", "STUDIO_ENVIRONMENT_ID", "STUDIO_RELEASE_COMMIT"]);
    for (const service of Object.values(out.services) as Array<{ keys: string[]; clerk: string | null; previousFieldsClerk: string | null }>) {
      expect(service.keys.filter(key => /^(?:NEXT_PUBLIC_|VITE_)?CLERK_/.test(key))).toEqual([]);
      expect(service.clerk).toBeNull();
      expect(service.previousFieldsClerk).toBe("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
    }
    // Nothing but Bun's own transpiler cache was created; no .config (where
    // Drafted's trusted credential key and backup live) was ever made.
    const created = (readdirSync(home, { recursive: true }) as string[]).map(entry => entry.split(path.sep).join("/"));
    expect(created.filter(entry => !["Library", "Library/Caches", "Library/Caches/bun"].includes(entry) && !entry.startsWith("Library/Caches/bun/"))).toEqual([]);
    expect(existsSync(path.join(home, ".config"))).toBe(false);
    clerk[release.revision] = out;
  }
  const probe = path.join(server.root, "transport-probe.ts");
  // Runs inside one Bun process per release, exactly like a CLI process:
  // `bun --no-env-file --preload <preload> <probe>` importing the checkout's module.
  writeFileSync(probe, `const [checkout, recipeFile, credentialsFile, branch] = process.argv.slice(2);
const { runtimeProviders } = await import(checkout + "/src/runtime-providers.ts");
const recipe = JSON.parse(await Bun.file(recipeFile).text()), secrets = JSON.parse(await Bun.file(credentialsFile).text());
const providers = runtimeProviders(recipe, secrets);
const out = {};
await providers.preflight(); out.preflight = "ok";
const receipts = [];
out.created = await providers.create("planetscale", branch, async receipt => { receipts.push(receipt); });
out.receipt = receipts[0];
out.inspect = await providers.inspect(receipts[0]);
out.resume = await providers.resume(receipts[0]);
out.schema = await providers.schema(receipts[0], async environment => Object.keys(environment).sort());
try { await providers.create("planetscale", branch, async () => {}); out.duplicate = "accepted"; } catch (error) { out.duplicate = String(error.message); }
const wrong = runtimeProviders(recipe, { ...secrets, STUDIO_PLANETSCALE_SERVICE_TOKEN: "wrong" });
try { await wrong.preflight(); out.wrongCredential = "accepted"; } catch (error) { out.wrongCredential = String(error.message); }
const other = runtimeProviders({ ...recipe, planetscale: { ...recipe.planetscale, organization: "someone-else" } }, secrets);
try { await other.preflight(); out.otherOrganization = "accepted"; } catch (error) { out.otherOrganization = String(error.message); }
try { await providers.release(receipts[0]); out.release = "accepted"; } catch (error) { out.release = String(error.message); }
for (const [name, init] of [["redirect", { redirect: "follow" }], ["delete", { method: "DELETE", redirect: "error" }]]) {
  try { await fetch("https://api.planetscale.com/v1/organizations/dra37-synthetic/databases/dra37-synthetic/branches/main", { ...init, headers: { authorization: secrets.STUDIO_PLANETSCALE_SERVICE_TOKEN_ID + ":" + secrets.STUDIO_PLANETSCALE_SERVICE_TOKEN } }); out[name] = "accepted"; }
  catch (error) { out[name] = String(error.message); }
}
console.log(JSON.stringify(out));
`, { mode: 0o600 });
  const results: Record<string, any> = {};
  for (const release of server.drafted!.releases) {
    const branch = `dra37-transport-${release.revision.slice(0, 8)}`;
    const child = Bun.spawnSync([process.execPath, "--no-env-file", "--preload", PRELOAD, probe, release.checkout, product.recipe, product.credentialsFile, branch],
      { cwd: server.root, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: server.root, TMPDIR: process.env.TMPDIR ?? "/tmp", DRA37_PLANETSCALE_DIRECTORY: product.planetscale } });
    expect(child.exitCode, child.stderr.toString().slice(-2_000)).toBe(0);
    const out = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
    results[release.revision] = out;
    expect(out.preflight).toBe("ok");
    expect(out.receipt).toMatchObject({ provider: "planetscale", name: branch });
    expect(out.inspect).toBe(true);
    for (const value of [out.created, out.resume]) {
      const url = new URL(value.DATABASE_URL);
      expect(url.hostname).toBe("dra37-synthetic-not-a-host.psdb.cloud");
      expect(url.password.startsWith("synthetic-not-a-password-")).toBe(true);
    }
    expect(out.schema).toContain("DATABASE_URL");
    // The admin password schema used was deleted exactly once by Drafted.
    expect(out.duplicate).toMatch(/exists without this task's receipt/);
    for (const refused of [out.wrongCredential, out.otherOrganization, out.release, out.redirect, out.delete]) expect(refused).toMatch(/Remote dependency request failed|DRA-37 synthetic PlanetScale refused/);
  }
  const requests = readJsonl(path.join(product.planetscale, "planetscale-requests.jsonl"));
  expect(requests.filter(entry => entry.outcome === "refused-external")).toEqual([]);
  expect(requests.filter(entry => entry.outcome === "loaded")).toHaveLength(2);
  const issued = readJsonl(path.join(product.planetscale, "planetscale-passwords.jsonl"));
  expect(issued.filter(entry => entry.role === "admin" && entry.event === "issued").length).toBe(2);
  expect(issued.filter(entry => entry.event === "deleted").length).toBe(2);
  const refusals = requests.filter(entry => entry.outcome === "refused").map(entry => entry.reason as string);
  // Every refusal is one of the probed kinds, each observed for both releases.
  // (release reaches its query-string deploy-request listing first: "non-exact URL").
  const expectedKinds = ["unexpected credential", "unscripted organization or database", "redirects must be refused by the caller", "non-exact URL", "unscripted operation"];
  expect(refusals.filter(reason => !expectedKinds.includes(reason))).toEqual([]);
  for (const kind of expectedKinds) expect(refusals.filter(reason => reason === kind).length, kind).toBeGreaterThanOrEqual(2);
  // No request or credential value is ever logged.
  const raw = readFileSync(path.join(product.planetscale, "planetscale-requests.jsonl"), "utf8");
  expect(raw.includes(credentials.STUDIO_PLANETSCALE_SERVICE_TOKEN!)).toBe(false);
  const transportEnd = provenance(server), transportStability = provenanceStability(transportStart, transportEnd);
  expect(transportStability.stable, JSON.stringify(transportStability)).toBe(true);
  writeFileSync(path.join(server.root, "transport-evidence.json"), JSON.stringify({ start: transportStart, end: transportEnd, stability: transportStability, clerk, recipe: { ...recipe, credentialsFile: "<private synthetic>" }, results, requests }, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ transport: { root: server.root, releases: server.drafted!.releases.map(release => release.revision), answered: requests.filter(entry => entry.outcome === "answered").length, refusals: refusals.length } }));
  passed = true;
});

test("transport: the server's real compute classifier is answered only by the armed, idle-gated synthetic decision preload", async () => {
  const root = (await import("node:fs")).mkdtempSync(path.join((await import("node:os")).tmpdir(), "dra37-decision-"));
  let passed = false;
  cleanups.push(async () => { if (passed && !process.env.DRA37_KEEP_EVIDENCE) (await import("node:fs")).rmSync(root, { recursive: true, force: true }); });
  const apiKey = `synthetic-not-a-credential-${crypto.randomUUID()}`;
  writeFileSync(path.join(root, "decision-state.json"), JSON.stringify({ apiKey }), { mode: 0o600 });
  const probe = path.join(root, "decision-probe.ts");
  writeFileSync(probe, `import { classifyCompute } from ${JSON.stringify(path.join(sourceRoot, "apps/server/services/tasks/compute-decision.ts"))};
import { writeFileSync } from "node:fs";
const [directory, apiKey] = process.argv.slice(2);
const evidence = (environmentId, overrides = {}) => ({ version: 2,
  task: { id: "dra37-task", primarySessionId: "dra37-primary", environmentId, purpose: "development", revision: "a".repeat(40) },
  observedAt: Date.now(), evidenceDigest: "b".repeat(64),
  traffic: { coverage: "complete", lastMeaningfulAt: null, lastUnknownAt: null, inFlight: 0, activeStreams: 0, quietForMs: 120000, collectorAgeMs: 1000, ...overrides.traffic },
  activity: { ownedSessionsSettled: true, operationsComplete: true, pendingInstructions: 0, ownerPaused: false, reviewProtected: false, latestInstructionAt: null },
  conversation: [], policy: { quietPeriodSeconds: 60, collectorFreshnessSeconds: 15 },
  measurement: { unknownInFlight: 0, probeConnections: 0, probeStreams: 0, lastUnknownAgeMs: null, coverageForMs: 120000, operations: { coverage: "complete", active: 0 } },
  thread: { name: null, issueIdentifier: null, taskPhase: "working", order: "oldest-to-newest", totalMessages: 0, windowMessages: 0, omittedMessages: 0, messageIndexes: [], truncations: [] } });
const out = {};
out.beforeArm = await classifyCompute(evidence("env-a"), { apiKey });
writeFileSync(directory + "/decision-arm.json", JSON.stringify({ environmentId: "env-a" }));
out.otherEnvironment = await classifyCompute(evidence("env-b"), { apiKey });
// Armed but NOT idle (one request in flight): the server's own deterministic
// gate refuses before any request (the preload's proof is a second check).
out.armedBusy = await classifyCompute(evidence("env-a", { traffic: { inFlight: 1 } }), { apiKey });
out.armedIdle = await classifyCompute(evidence("env-a"), { apiKey });
out.afterConsumed = await classifyCompute(evidence("env-a"), { apiKey });
out.wrongCredential = await classifyCompute(evidence("env-a"), { apiKey: "synthetic-wrong" });
try { await fetch("https://example.invalid/"); out.otherHost = "accepted"; } catch (error) { out.otherHost = String(error.message); }
try { await fetch("https://api.openai.com/v1/decisions", { method: "POST", redirect: "follow", headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" }, body: "{}" }); out.redirect = "accepted"; } catch (error) { out.redirect = String(error.message); }
console.log(JSON.stringify(out));
`, { mode: 0o600 });
  const child = Bun.spawnSync([process.execPath, "--no-env-file", "--preload", DECISION_PRELOAD, probe, root, apiKey], { cwd: sourceRoot, stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, TMPDIR: process.env.TMPDIR ?? "/tmp", DRA37_DECISION_DIRECTORY: root } });
  expect(child.exitCode, child.stderr.toString().slice(-2_000)).toBe(0);
  const out = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
  expect(out.beforeArm).toMatchObject({ kind: "recommendation", choice: "leave-running" });
  expect(out.otherEnvironment).toMatchObject({ kind: "recommendation", choice: "leave-running" });
  expect(out.armedBusy).toMatchObject({ kind: "diagnostic", failure: "ineligible-evidence" });
  expect(out.armedIdle).toMatchObject({ kind: "recommendation", choice: "suspend-compute", confidence: 0.9, requested: true });
  expect(out.afterConsumed).toMatchObject({ kind: "recommendation", choice: "leave-running" });
  expect(out.wrongCredential).toMatchObject({ failure: "request-failed" });
  expect(out.otherHost).toMatch(/refused unexpected outbound external host or path/);
  expect(out.redirect).toMatch(/redirects must be refused/);
  const entries = readJsonl(path.join(root, "decision-requests.jsonl"));
  expect(entries.filter(entry => entry.outcome === "answered").map(entry => entry.response.answers[0].choice)).toEqual(["leave-running", "leave-running", "suspend-compute", "leave-running"]);
  for (const entry of entries.filter(value => value.outcome === "answered")) {
    expect(entry.requestSchema).toEqual({ keys: ["input", "model", "questions"], model: "gpt-6-luna", question: "compute_action", choices: ["leave-running", "suspend-compute", "eligible-for-authorized-closure"] });
    expect(entry.respondedAt).toBeGreaterThanOrEqual(entry.receivedAt);
  }
  expect(entries.filter(entry => entry.outcome === "refused").map(entry => entry.reason).sort()).toEqual(["redirects must be refused by the caller", "unexpected credential", "unexpected outbound external host or path"]);
  expect(readFileSync(path.join(root, "decision-requests.jsonl"), "utf8").includes(apiKey)).toBe(false);
  console.log(JSON.stringify({ decisionTransport: { root, answered: entries.filter(entry => entry.outcome === "answered").length, refused: 3 } }));
  passed = true;
});

// ---------------------------------------------------------------------------
// Physical committed-CLI A/B acceptance.
// ---------------------------------------------------------------------------
const physical = process.env.DRA37_REAL_DOCKER === "1" && process.env.DRA37_AB_ACCEPTANCE === "1";
test.skipIf(!physical)("physical: A environment and retained consumer survive B activation, then B adopts the same stopped environment", async () => {
  const server = await dra37Server({ slots: 1, drafted: { source: SOURCE, revision: RELEASE_A, additionalRevisions: [RELEASE_B] }, docker: "real", cli: { preload: PRELOAD },
    decision: { preload: DECISION_PRELOAD, quietPeriodSeconds: 60 } });
  let passed = false;
  // Acceptance evidence is always preserved; Docker objects are always cleaned by exact ID.
  cleanups.push(() => server.cleanup({ keepEvidence: true }));
  const evidenceFile = path.join(server.root, "ab-evidence.json");
  const [releaseA, releaseB] = server.drafted!.releases as [NonNullable<Server["drafted"]>["release"], NonNullable<Server["drafted"]>["release"]];
  const evidence: Record<string, any> = { scope: "real isolated Remote Agent server; supported frozen Drafted A/B releases; committed Drafted CLI/operation guards/runtime/Docker transports/observer; real local containers behind the fixture guard; synthetic ACP primary; test-only synthetic PlanetScale API preload in CLI processes",
    serverRoot: server.root, start: provenance(server), steps: [] as unknown[] };
  const step = (action: string, detail: object = {}) => { evidence.steps.push({ action, at: new Date().toISOString(), ...detail }); };
  const prisma = server.db.prisma;
  const real = server.real!;
  const docker = (...args: string[]) => Bun.spawnSync([real.docker, ...args], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
  const json = async (response: Response, status: number) => { const body = await response.json().catch(() => null) as Record<string, any> | null; expect(response.status, JSON.stringify(body)).toBe(status); return body!; };
  const post = (route: string, body: unknown) => server.request(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const cliRuns = async () => (await server.agentEvents() as Array<Record<string, any>>).filter(event => event.event === "cli-run" || event.event === "cli-error");
  const ownerPaused = async () => Object.fromEntries((await prisma.remoteTask.findMany()).map(task => [task.id, task.ownerPaused]));
  const containers = (taskId: string) => server.dockerLedger().filter(entry => entry.kind === "container").flatMap(entry => {
    const [row] = JSON.parse(docker("inspect", entry.id) || "[]") as Array<{ Id: string; Name: string; Config: { Labels: Record<string, string> }; State: { Status: string; Running: boolean; ExitCode: number; Pid: number } }>;
    if (!row || row.Config.Labels["dev.drafted.task"] !== taskId) return [];
    return [{ role: row.Name.endsWith("-proxy") ? "proxy" : row.Name.endsWith("-app") ? "app" : "other", id: row.Id, name: row.Name, status: row.State.Status, running: row.State.Running, exitCode: row.State.ExitCode, pid: row.State.Pid }];
  });
  const activate = async (revision: string, expectedGeneration: number, requestKey: string) => {
    const before = server.pid;
    const receipt = await json(await post(`/api/tooling-releases/${REPOSITORY}/activations`, { revision, expectedGeneration, requestKey }), 200);
    expect(server.pid).toBe(before);
    step("activation", { revision, expectedGeneration, requestKey, pid: server.pid, receipt, ownerPaused: await ownerPaused() });
    return receipt;
  };
  const instruct = async (taskId: string, requestKey: string, text: string) => step("owner-instruction", { taskId, requestKey, text, response: await json(await post(`/api/tasks/${encodeURIComponent(taskId)}/instructions`, { requestKey, text }), 202) });
  const runAfter = (count: number, label: string, done: (run: Record<string, any>) => boolean) => until(label, async () => {
    const runs = (await cliRuns()).slice(count);
    const failed = runs.find(run => run.event === "cli-error" || run.code !== 0);
    if (failed) throw new Error(`${label}: committed CLI run failed: ${JSON.stringify(failed).slice(0, 4_000)}`);
    return runs.find(done) ?? null;
  });
  /** Waits until no operation in scope is bound/running, then requires every
   * one to be `completed`. `unknown` (or anything else) fails with the exact
   * rows as diagnosis, as does a timeout. */
  const requireCompleted = async (label: string, where: Parameters<typeof prisma.toolingOperation.findMany>[0], ms = 180_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const rows = await prisma.toolingOperation.findMany({ ...where, orderBy: { createdAt: "asc" } });
      const open = rows.filter(row => ["bound", "running"].includes(row.status));
      if (!open.length) {
        const incomplete = rows.filter(row => row.status !== "completed");
        if (!rows.length || incomplete.length) throw new Error(`${label}: ${rows.length ? "operations did not complete" : "no operations in scope"}: ${JSON.stringify(incomplete.length ? incomplete : rows).slice(0, 6_000)}`);
        return rows;
      }
      if (Date.now() > deadline) throw new Error(`${label}: operations still open after ${ms} ms: ${JSON.stringify(open).slice(0, 6_000)}`);
      await Bun.sleep(250);
    }
  };
  const newestConfirmed = (rows: Array<{ status: string; createdAt: Date }>) => {
    const confirmed = rows.filter(row => row.status === "confirmed").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    if (confirmed.length !== 1) throw new Error(`Expected exactly one confirmed retained consumer (supersession leaves older rows non-confirmed): ${JSON.stringify(rows).slice(0, 4_000)}`);
    return confirmed[0]!;
  };
  const hold = async (point: string, url: string, detail: object) => {
    if (HOLD_SECONDS <= 0 || HOLD_AT !== point) return;
    // Released ONLY by the release file or the bound: no health watcher.
    const holdFile = process.env.DRA37_HOLD_FILE ? path.resolve(process.env.DRA37_HOLD_FILE) : path.join(server.root, "hold.json");
    const releaseFile = `${holdFile}.release`, until = new Date(Date.now() + HOLD_SECONDS * 1_000);
    if (existsSync(releaseFile)) throw new Error(`Stale hold release file ${releaseFile}; remove it before holding`);
    writeFileSync(holdFile, JSON.stringify({ point, url, ...detail, serverRoot: server.root, prefix: real.prefix, ledger: server.dockerLedger(), heldAt: new Date().toISOString(),
      until: until.toISOString(), resume: `touch ${JSON.stringify(releaseFile)}` }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ hold: { point, file: holdFile, url, until: until.toISOString() } }));
    while (!existsSync(releaseFile) && Date.now() < until.getTime()) await Bun.sleep(500);
    step("hold-resumed", { point, by: existsSync(releaseFile) ? "release-file" : "bound", ledgerUnchanged: JSON.stringify(server.dockerLedger()) === JSON.stringify(JSON.parse(readFileSync(holdFile, "utf8")).ledger) });
  };

  try {
    const product = await server.prepareCliProduct();
    step("prepared", { releases: server.drafted!.releases, product: { recipe: product.recipe, planetscale: product.planetscaleState } });
    // --- 1. Paused control: identity seed, paused through the owner route.
    await prisma.remoteTask.create({ data: { id: "dra37-control", requestKey: "dra37-control", repositoryId: REPOSITORY, machineId: MACHINE, branchName: "dra37/control",
      toolingRoot: server.drafted!.source, toolingRevision: RELEASE_A, phase: "working" } });
    await server.start();
    const pid = server.pid;
    expect((await json(await server.request(`/api/tooling-releases/${REPOSITORY}`), 200)).selection).toBeNull();
    step("owner-pause-control", { response: await json(await post("/api/tasks/dra37-control/automation", { action: "pause" }), 200) });
    expect((await ownerPaused())["dra37-control"]).toBe(true);

    // --- 2. Activation A.
    const a = await activate(RELEASE_A, 0, "dra37-ab-activate-a");
    expect(a.selection).toMatchObject({ generation: 1, release: { revision: RELEASE_A } });
    expect((await prisma.toolingRelease.findFirstOrThrow({ where: { repositoryId: REPOSITORY, revision: RELEASE_A } })).checkout).toBe(releaseA.checkout);

    // --- 3. Normal launch; the primary runs A's committed runtime up and claims its offer.
    const launched = await json(await post("/api/tasks", { requestKey: "dra37-ab-task", repositoryId: REPOSITORY, branchName: "dra37/ab", prompt: "DRA37-RUNTIME: up", provider: "codex" }), 201);
    const taskId = launched.task.id as string;
    const task = await until("launched primary", async () => { const row = await prisma.remoteTask.findUnique({ where: { id: taskId } }); return row?.primarySessionId ? row : null; });
    expect({ toolingRevision: task.toolingRevision, pinnedToolingRoot: task.pinnedToolingRoot }).toEqual({ toolingRevision: RELEASE_A, pinnedToolingRoot: releaseA.checkout });
    step("launch", { task: { id: task.id, primarySessionId: task.primarySessionId, worktreePath: task.worktreePath, toolingRevision: task.toolingRevision, pinnedToolingRoot: task.pinnedToolingRoot } });
    const readyA = await runAfter(0, "A runtime ready", run => run.result?.phase === "ready");
    const runsA = await cliRuns();
    for (const run of runsA) expect(run.capability.checkout, JSON.stringify(run).slice(0, 1_000)).toBe(releaseA.checkout);
    const environment = await prisma.computeEnvironment.findFirstOrThrow({ where: { taskId } });
    const appA = containers(taskId).find(value => value.role === "app")!;
    expect(appA).toMatchObject({ status: "running", running: true });
    const urlA = (readyA.result as { urls: Record<string, string> }).urls.api!;
    expect(await (await fetch(new URL("/health", urlA))).json()).toMatchObject({ ready: true });
    const releaseRowA = await prisma.toolingRelease.findFirstOrThrow({ where: { repositoryId: REPOSITORY, revision: RELEASE_A } });
    const consumersA = await prisma.toolingRetainedConsumer.findMany({ where: { consumerId: environment.id } });
    const confirmedA = newestConfirmed(consumersA) as (typeof consumersA)[number];
    expect(confirmedA, JSON.stringify(consumersA)).toMatchObject({ releaseId: releaseRowA.id, generation: 1, consumerKind: "compute-environment" });
    const operationsA = await prisma.toolingOperation.findMany({ where: { taskId } });
    expect(operationsA.every(row => row.releaseId === releaseRowA.id), JSON.stringify(operationsA)).toBe(true);
    const producer = operationsA.find(row => row.id === confirmedA!.operationId)!;
    await until("A running observation", async () => ((await prisma.computeEnvironment.findUniqueOrThrow({ where: { id: environment.id } })).observation as { state?: string } | null)?.state === "running");
    step("a-ready", { cliRuns: runsA, environment: { id: environment.id, resourceId: environment.resourceId }, app: appA, url: urlA, consumers: consumersA, operations: operationsA });

    // --- 4. Activation B, same PID.
    const b = await activate(RELEASE_B, 1, "dra37-ab-activate-b");
    expect(b.selection).toMatchObject({ generation: 2, release: { revision: RELEASE_B } });
    expect((await prisma.toolingRelease.findFirstOrThrow({ where: { repositoryId: REPOSITORY, revision: RELEASE_B } })).checkout).toBe(releaseB.checkout);
    expect(server.pid).toBe(pid);
    const activatedB = Date.now();

    // --- 5. The server's observer keeps running A's checkout with A's producer operation.
    const observerCalls = await until("an observer call after B activation", async () => {
      const calls = readJsonl(path.join(server.apps, "docker-calls.jsonl")).filter(call => call.at > activatedB && call.args && call.operation);
      return calls.length ? calls : null;
    });
    // Executed from A's checkout, under one of A's own (producer) operations.
    const operationIdsA = new Set(operationsA.map(row => row.id));
    for (const call of observerCalls) {
      expect(call.cwd, JSON.stringify(call)).toBe(releaseA.checkout);
      expect(operationIdsA.has(call.operation), JSON.stringify(call)).toBe(true);
    }
    const observedAfterB = await until("a fresh running observation after B activation", async () => {
      const observation = (await prisma.computeEnvironment.findUniqueOrThrow({ where: { id: environment.id } })).observation as { state?: string; observedAt?: number } | null;
      return observation && (observation.observedAt ?? 0) > activatedB && observation.state === "running" ? observation : null;
    });
    const stillConfirmed = await prisma.toolingRetainedConsumer.findUniqueOrThrow({ where: { id: confirmedA!.id } });
    expect(stillConfirmed.status).toBe("confirmed");
    step("observer-remains-a", { observerCalls: observerCalls.slice(0, 5), observation: observedAfterB, producer: { id: producer.id, kind: producer.kind, releaseId: producer.releaseId },
      retainedConsumer: { id: stillConfirmed.id, releaseId: stillConfirmed.releaseId, generation: stillConfirmed.generation, status: stillConfirmed.status } });
    await hold("after-b-activation", urlA, { taskId, environmentId: environment.id, activeRelease: RELEASE_B, servingRelease: RELEASE_A });

    // --- 6. Natural server-derived idle suspension and retained continuation on A.
    // Arm the synthetic decision transport for this exact environment, then
    // make one ordinary application request so the idle episode starts after
    // arming (an earlier conservative leave-running is superseded by real use).
    const decisionLog = path.join(server.decisionDirectory!, "decision-requests.jsonl");
    writeFileSync(path.join(server.decisionDirectory!, "decision-arm.json"), JSON.stringify({ environmentId: environment.id }), { mode: 0o600, flag: "wx" });
    const armedAt = Date.now();
    const touch = await fetch(new URL("/", urlA), { redirect: "error", signal: AbortSignal.timeout(10_000) });
    step("decision-armed", { environmentId: environment.id, armedAt: new Date(armedAt).toISOString(), touch: { status: touch.status } });
    await touch.arrayBuffer();
    const suspendAnswer = await until("the armed idle decision request", async () => {
      const entries = readJsonl(decisionLog);
      const refused = entries.find(entry => entry.outcome === "refused");
      if (refused) throw new Error(`Decision transport refused a request: ${JSON.stringify(refused)}`);
      return entries.find(entry => entry.outcome === "answered" && entry.response.answers[0].choice === "suspend-compute") ?? null;
    }, 600_000);
    expect(suspendAnswer).toMatchObject({ armed: true, idleProof: { idle: true }, evidence: { environmentId: environment.id } });
    expect(suspendAnswer.evidence.traffic.quietForMs).toBeGreaterThanOrEqual(suspendAnswer.evidence.policy.quietPeriodSeconds * 1000);
    // The server's own decision receipt and runtime-suspended intent.
    const decisionReceipt = await until("the server decision receipt", async () => {
      const rows = await prisma.runtimeMetadataEvent.findMany({ where: { source: `compute:${taskId}`, action: "compute-idle-decision" }, orderBy: { sequence: "asc" } });
      return rows.map(row => ({ sequence: row.sequence, key: row.key, value: JSON.parse(row.value ?? "null") })).find(row => row.value?.outcome === "suspension-recorded") ?? null;
    });
    expect(decisionReceipt.value.result).toMatchObject({ choice: "suspend-compute", evidenceDigest: suspendAnswer.evidence.evidenceDigest });
    // The server-started continuation binds through A's confirmed retained consumer.
    const continuation = await until("the retained continuation operation", async () =>
      (await prisma.toolingOperation.findMany({ where: { taskId, retainedConsumerId: confirmedA!.id } }))[0] ?? null);
    expect(continuation.releaseId).toBe(releaseRowA.id);
    const stoppedApp = await until("the app stopped by the continuation", async () => {
      const app = containers(taskId).find(value => value.id === appA.id)!;
      return app.running ? null : app;
    });
    expect(stoppedApp).toMatchObject({ status: "exited", running: false });
    const continuationCalls = readJsonl(path.join(server.apps, "docker-calls.jsonl")).filter(call => call.args && call.operation === continuation.id);
    expect(continuationCalls.length, "the continuation reached Docker under its own operation").toBeGreaterThan(0);
    for (const call of continuationCalls) expect(call.cwd, JSON.stringify(call)).toBe(releaseA.checkout);
    await until("app observed stopped", async () => ((await prisma.computeEnvironment.findUniqueOrThrow({ where: { id: environment.id } })).observation as { state?: string } | null)?.state === "stopped");
    const resolvedA = await until("A retained consumer resolved after proven stop", async () => {
      const row = await prisma.toolingRetainedConsumer.findUniqueOrThrow({ where: { id: confirmedA!.id } });
      return row.status === "resolved" ? row : null;
    });
    // Settlement proof (separate from the consumer resolution above): the
    // continuation and every A command/child of this task completed.
    const [settledContinuation] = await requireCompleted("A continuation", { where: { id: continuation.id } });
    const completedA = await requireCompleted("A commands and children through the continuation", { where: { taskId, releaseId: releaseRowA.id } });
    expect((await cliRuns()).filter(run => run.label === "runtime-stop")).toEqual([]);
    step("idle-continuation-on-a", { proof: "app stopped by the server-derived idle continuation bound to A's retained consumer, executed from A's checkout, and observed stopped; the continuation and every A command/child completed; A's retained consumer resolved (separately proven)",
      completedA: completedA.map(row => ({ id: row.id, kind: row.kind, requestKey: row.requestKey, parentOperationId: row.parentOperationId, retainedConsumerId: row.retainedConsumerId, status: row.status })),
      decision: { requestAt: suspendAnswer.receivedAt, respondedAt: suspendAnswer.respondedAt, requestSchema: suspendAnswer.requestSchema, idleProof: suspendAnswer.idleProof, response: suspendAnswer.response },
      decisionReceipt, continuation: settledContinuation, continuationCalls: continuationCalls.slice(0, 8), engine: containers(taskId), resolvedA,
      offers: await prisma.computeOffer.findMany({ where: { environmentId: environment.id } }), slots: await prisma.computeSlot.findMany() });

    // --- 7. Owner instruction: B's committed runtime up adopts the same environment/resource/container.
    const beforeResume = (await cliRuns()).length, resumeStartedAt = new Date();
    const ledgerBefore = server.dockerLedger().length;
    await instruct(taskId, "dra37-ab-resume", "DRA37-RUNTIME: up");
    const readyB = await runAfter(beforeResume, "B runtime ready", run => run.result?.phase === "ready");
    const runsB = (await cliRuns()).slice(beforeResume);
    for (const run of runsB) expect(run.capability.checkout, JSON.stringify(run).slice(0, 1_000)).toBe(releaseB.checkout);
    const environmentAfter = await prisma.computeEnvironment.findMany({ where: { taskId } });
    expect(environmentAfter.map(row => ({ id: row.id, resourceId: row.resourceId }))).toEqual([{ id: environment.id, resourceId: environment.resourceId }]);
    const appB = containers(taskId).find(value => value.role === "app")!;
    expect(appB).toMatchObject({ id: appA.id, status: "running", running: true });
    expect(server.dockerLedger().length, "B adopted existing Docker objects rather than creating new ones").toBe(ledgerBefore);
    const urlB = (readyB.result as { urls: Record<string, string> }).urls.api!;
    expect(await (await fetch(new URL("/health", urlB))).json()).toMatchObject({ ready: true });
    const releaseRowB = await prisma.toolingRelease.findFirstOrThrow({ where: { repositoryId: REPOSITORY, revision: RELEASE_B } });
    const consumersB = await prisma.toolingRetainedConsumer.findMany({ where: { consumerId: environment.id } });
    expect(newestConfirmed(consumersB), JSON.stringify(consumersB)).toMatchObject({ releaseId: releaseRowB.id, generation: 2 });
    expect(consumersB.find(row => row.id === confirmedA.id)?.status).toBe("resolved");
    const completedResume = await requireCompleted("B resume commands and children", { where: { taskId, releaseId: releaseRowB.id, createdAt: { gte: resumeStartedAt } } });
    step("b-adopted", { completedResume: completedResume.map(row => ({ id: row.id, kind: row.kind, requestKey: row.requestKey, status: row.status })), cliRuns: runsB, environment: environmentAfter, app: appB, url: urlB, consumers: consumersB, operations: await prisma.toolingOperation.findMany({ where: { taskId } }) });
    await hold("after-b-resume", urlB, { taskId, environmentId: environment.id, activeRelease: RELEASE_B, servingRelease: RELEASE_B });

    // --- 8. Final normal stop through B, then exact cleanup (afterEach).
    const beforeFinal = (await cliRuns()).length, finalStartedAt = new Date();
    await instruct(taskId, "dra37-ab-final-stop", "DRA37-RUNTIME: stop");
    const finalStop = await runAfter(beforeFinal, "final runtime stop", run => run.label === "runtime-stop");
    expect(finalStop.capability.checkout).toBe(releaseB.checkout);
    // The exact adopted app container is stopped (pid 0) ...
    const finalEngine = containers(taskId);
    expect(finalEngine.find(value => value.id === appA.id), JSON.stringify(finalEngine)).toMatchObject({ role: "app", status: "exited", running: false, pid: 0 });
    // ... a FRESH observation (after the stop began) reports it stopped ...
    const finalObservation = await until("fresh stopped observation after the final stop", async () => {
      const observation = (await prisma.computeEnvironment.findUniqueOrThrow({ where: { id: environment.id } })).observation as { state?: string; observedAt?: number } | null;
      return observation && observation.state === "stopped" && (observation.observedAt ?? 0) > finalStartedAt.getTime() ? observation : null;
    });
    // ... and B's terminal stop command (and any children) completed on B.
    const completedFinal = await requireCompleted("final B stop command", { where: { taskId, createdAt: { gte: finalStartedAt } } });
    expect(completedFinal.every(row => row.releaseId === releaseRowB.id), JSON.stringify(completedFinal)).toBe(true);
    expect(completedFinal.some(row => row.parentOperationId === null), "a root (command) operation for the final stop").toBe(true);
    const finalProxy = finalEngine.find(value => value.role === "proxy");
    step("final-stop", { proof: "the exact adopted app container exited (pid 0), a fresh observation reports stopped, and B's terminal stop command completed",
      finalStop, engine: finalEngine, observation: finalObservation,
      completedFinal: completedFinal.map(row => ({ id: row.id, kind: row.kind, requestKey: row.requestKey, parentOperationId: row.parentOperationId, status: row.status })),
      proxy: { ...finalProxy, note: "Drafted's normal stop stops the app only; the nginx proxy container keeps running until the fixture's exact-ID cleanup. No claim is made that it is stopped or uncharged before cleanup." } });
    expect(server.pid).toBe(pid);
    expect((await ownerPaused())["dra37-control"]).toBe(true);
    const providerRequests = readJsonl(path.join(product.planetscale, "planetscale-requests.jsonl"));
    expect(providerRequests.filter(entry => entry.outcome === "refused" || entry.outcome === "refused-external"), JSON.stringify(providerRequests).slice(0, 3_000)).toEqual([]);
    const decisionRequests = readJsonl(path.join(server.decisionDirectory!, "decision-requests.jsonl"));
    expect(decisionRequests.filter(entry => entry.outcome === "refused"), JSON.stringify(decisionRequests).slice(0, 3_000)).toEqual([]);
    expect(decisionRequests.filter(entry => entry.outcome === "loaded").map(entry => entry.pid)).toEqual([pid]);
    expect(decisionRequests.filter(entry => entry.response?.answers[0].choice === "suspend-compute")).toHaveLength(1);
    const stability = provenanceStability(evidence.start, provenance(server));
    expect(stability.stable, JSON.stringify(stability)).toBe(true);
    passed = true;
  } finally {
    evidence.passed = passed;
    evidence.end = provenance(server);
    evidence.stability = provenanceStability(evidence.start, evidence.end);
    const prismaRows = async () => ({ selection: await prisma.toolingSelection.findMany(), activations: await prisma.toolingActivation.findMany(), releases: await prisma.toolingRelease.findMany(),
      operations: await prisma.toolingOperation.findMany(), consumers: await prisma.toolingRetainedConsumer.findMany(), environments: await prisma.computeEnvironment.findMany(),
      offers: await prisma.computeOffer.findMany(), slots: await prisma.computeSlot.findMany(), instructions: await prisma.runtimeInstruction.findMany(),
      tasks: await prisma.remoteTask.findMany({ select: { id: true, primarySessionId: true, toolingRevision: true, pinnedToolingRoot: true, ownerPaused: true, phase: true } }) });
    evidence.rows = await prismaRows().catch(error => ({ error: String(error) }));
    evidence.agent = await server.agentEvents().catch(() => []);
    evidence.providerRequests = readJsonl(path.join(server.root, "planetscale", "planetscale-requests.jsonl"));
    evidence.decisionRequests = readJsonl(path.join(server.root, "decision", "decision-requests.jsonl"));
    evidence.decisionReceipts = await prisma.runtimeMetadataEvent.findMany({ where: { action: { in: ["compute-idle-decision", "compute-idle-attempt"] } }, orderBy: { sequence: "asc" } }).catch(error => String(error));
    evidence.ledger = server.dockerLedger();
    writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ abEvidence: evidenceFile, passed }));
  }
});
