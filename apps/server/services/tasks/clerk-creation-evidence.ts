import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { assertPreparedCleanup } from "./cleanup-lifecycle.ts";
import { readArchiveBytes } from "./archive-observation.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";
import { retirementDigest } from "./retirement-receipts.ts";
import { ClerkCreationWitness, legacyCreatedInstance } from "./clerk-creation-schema.ts";
import { legacyClerkCreationCommand, legacyClerkJwksScript, legacyClerkUserScript } from "./clerk-creation-recipe.ts";

const ACTION = "cleanup-clerk-original-creation";
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const File = z.object({ path: z.string(), dev: z.number(), ino: z.number(), mode: z.number(), size: z.number(), sha256: Digest }).strict();
const Actor = z.object({ id: z.string(), acpxRecordId: z.string(), acpxSessionId: z.string(), cwd: z.string(), repositoryId: z.string(), machineId: z.string(),
  relation: z.object({ id: z.string(), sourceSessionId: z.string(), targetSessionId: z.string(), createdAt: z.string() }).strict() }).strict();
const Scope = ClerkCreationWitness.omit({ evidenceRevision: true, evidenceDigest: true });
const Fact = z.object({ scope: Scope, bindingDigest: Digest, actor: Actor,
  evidence: z.object({ recordId: z.string(), message: z.number().int().nonnegative(), creationCall: z.string(), creationDigest: Digest,
    registrationCall: z.string(), registrationDigest: Digest, script: File, jwksScript: File, credentials: File }).strict(),
}).strict();
type Fact = z.infer<typeof Fact>;
type Active = Awaited<ReturnType<typeof assertPreparedCleanup>>;
type Database = Pick<PrismaClient, "runtimeSession" | "runtimeSessionRelation" | "runtimeMetadataEvent" | "remoteTaskResource">;
type Resource = Active["binding"]["resources"][number];
const equal = (a: unknown, b: unknown) => finalizationDigest(a) === finalizationDigest(b);
const object = (value: unknown) => z.record(z.string(), z.unknown()).parse(value);
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");

async function held(file: string, limit: number, privateFile: boolean) {
  const before = await lstat(file), bytes = await readArchiveBytes(file, limit), after = await lstat(file);
  if ((before.mode & 0o7777) !== (privateFile ? 0o600 : 0o644) || before.dev !== after.dev || before.ino !== after.ino
    || before.mode !== after.mode || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Original Clerk creation input changed");
  return { bytes, identity: { path: file, dev: before.dev, ino: before.ino, mode: before.mode, size: before.size, sha256: sha(bytes) } };
}

function scope(active: Active, resource: Resource) {
  const metadata = object(resource.metadata), instanceId = legacyCreatedInstance(metadata.instance), email = z.email().parse(metadata.email);
  if (active.kind !== "v1" || resource.kind !== "clerk-test-user" || resource.purpose !== "development" || metadata.createdByTask !== undefined
    || metadata.shared === true || metadata.preserved === true || metadata.preserve === true || !instanceId
    || !/^user_[A-Za-z0-9]+$/.test(resource.externalId) || metadata.clerkUserId !== undefined && metadata.clerkUserId !== resource.externalId
    || email !== `dra${active.binding.issueIdentifier.slice(4)}.${active.task.id.slice(0, 8)}+clerk_test@example.com`
    || !/^DRA-[1-9][0-9]*$/.test(active.binding.issueIdentifier)) throw new Error("Original Clerk creation receipt has no supported exact identity");
  return Scope.parse({ version: 1, taskId: active.task.id, sessionId: active.binding.sessionId, resourceId: resource.id,
    resourceDigest: finalizationResourceIdentity(resource).identityDigest, preparedRevision: active.preparation.sequence,
    operationRevision: active.operationRevision, operationDigest: retirementDigest(active.operation), instanceId, userId: resource.externalId, emailDigest: finalizationDigest(email) });
}
function eventWhere(active: Active, resourceId: string) {
  return { runtimeSessionId: active.binding.sessionId, source: `cleanup-evidence:${active.task.id}`, action: ACTION,
    key: `${active.operationRevision}:${resourceId}` };
}
function actorSnapshot(actor: { id: string; acpxRecordId: string | null; acpxSessionId: string | null; cwd: string; repositoryId: string; machineId: string }, relation: { id: string; sourceSessionId: string; targetSessionId: string; createdAt: Date }) {
  return Actor.parse({ id: actor.id, acpxRecordId: actor.acpxRecordId, acpxSessionId: actor.acpxSessionId, cwd: actor.cwd,
    repositoryId: actor.repositoryId, machineId: actor.machineId, relation: { id: relation.id, sourceSessionId: relation.sourceSessionId, targetSessionId: relation.targetSessionId, createdAt: relation.createdAt.toISOString() } });
}

/** Parse paired structured records only. Text messages, bare stdout and an
 * unrelated successful tool cannot substitute for the creating invocation. */
export function originalClerkToolEvidence(recordValue: unknown, input: { actor: z.infer<typeof Actor>; resource: Resource; resourceCreatedAt: string; taskId: string; environment: string; instanceId: string; email: string }) {
  const record = z.object({ schema: z.literal("acpx.session.v1"), acpx_record_id: z.string(), acp_session_id: z.string(), name: z.string(), cwd: z.string(), messages: z.array(z.unknown()).max(2000) }).parse(recordValue);
  if (record.acpx_record_id !== input.actor.acpxRecordId || record.acp_session_id !== input.actor.acpxSessionId || record.name !== input.actor.id || record.cwd !== input.actor.cwd) throw new Error("Original Clerk execution belongs to another session");
  const matches: Array<{ recordId: string; message: number; creationCall: string; creationDigest: string; registrationCall: string; registrationDigest: string }> = [];
  const ids = new Set<string>();
  for (const [message, raw] of record.messages.entries()) {
    if (!raw || typeof raw !== "object" || !("Agent" in raw)) continue;
    const agent = z.object({ content: z.array(z.unknown()).max(10000), tool_results: z.record(z.string(), z.unknown()).default({}) }).parse(raw.Agent);
    const tools = agent.content.flatMap((value, index) => value && typeof value === "object" && "ToolUse" in value ? [{ index, tool: object(value.ToolUse) }] : []);
    for (const { tool } of tools) {
      const id = z.string().min(1).max(200).parse(tool.id);
      if (ids.has(id)) throw new Error("Original Clerk execution contains duplicate tool IDs"); ids.add(id);
    }
    function successful(tool: Record<string, unknown>) {
      if (tool.is_input_complete !== true || !equal(JSON.parse(z.string().parse(tool.raw_input)), tool.input)) throw new Error("Original Clerk tool input is incomplete or inconsistent");
      const result = object(agent.tool_results[z.string().parse(tool.id)]);
      if (result.is_error !== false || result.tool_use_id !== tool.id || result.tool_name !== tool.name) throw new Error("Original Clerk tool has no paired successful result");
      return result;
    }
    for (const registration of tools.filter(({ tool }) => tool.name === "mcp__remote-agent__register_resource")) {
      const registered = object(registration.tool.input);
      if (registered.key !== input.resource.key || registered.externalId !== input.resource.externalId) continue;
      if (!equal(finalizationResourceIdentity({ ...registered, id: input.resource.id } as Resource), finalizationResourceIdentity(input.resource)) || registered.state !== "ready") throw new Error("Original Clerk registration differs from the frozen resource");
      const result = successful(registration.tool), output = z.tuple([z.object({ type: z.literal("text"), text: z.string() }).strict()]).parse(result.output);
      if (!equal(JSON.parse(z.string().parse(object(result.content).Text)), output)) throw new Error("Original Clerk registration result is inconsistent");
      const returned = object(JSON.parse(output[0].text)).resource, receipt = object(returned);
      if (receipt.taskId !== input.taskId || receipt.id !== input.resource.id || receipt.state !== "ready" || receipt.createdAt !== input.resourceCreatedAt
        || !equal(finalizationResourceIdentity(receipt as Resource), finalizationResourceIdentity(input.resource))) throw new Error("Original Clerk registration result belongs to another resource");
      const command = legacyClerkCreationCommand(input.environment);
      const creations = tools.filter(({ index, tool }) => index < registration.index && tool.name === command && object(tool.input).command === command);
      if (creations.length !== 1) throw new Error("Original Clerk registration has no unambiguous creating invocation");
      const creation = creations[0]!, created = successful(creation.tool), text = z.string().max(65536).parse(created.output);
      if (object(created.content).Text !== text) throw new Error("Original Clerk creation result is inconsistent");
      const lines = text.split("\n"), first = z.object({ kid: z.literal(input.instanceId), keys: z.literal(1) }).strict().parse(JSON.parse(lines[0]!));
      const second = z.object({ userId: z.literal(input.resource.externalId), email: z.literal(input.email), created: z.literal(true) }).strict().parse(JSON.parse(lines[1]!));
      // Only the known file-listing/cwd trailer may follow the two actual JSON
      // results. Additional JSON or a second create/reuse result is ambiguous.
      if (lines.slice(2).some(line => line && !/^-rw-------@?\s+\d+\s+\S+\s+\S+\s+\d+\s+[A-Z][a-z]{2}\s+\d+\s+[0-9:]+\s+clerk-(?:jwt\.pem|user\.json)$/.test(line)
        && line !== `Shell cwd was reset to ${input.actor.cwd}`)) throw new Error("Original Clerk creation output has unsupported trailing data");
      void first; void second;
      matches.push({ recordId: record.acpx_record_id, message, creationCall: String(creation.tool.id), creationDigest: finalizationDigest({ tool: creation.tool, result: created }),
        registrationCall: String(registration.tool.id), registrationDigest: finalizationDigest({ tool: registration.tool, result }) });
    }
  }
  if (matches.length > 1) throw new Error("Original Clerk creation evidence is ambiguous");
  return matches[0];
}

/** Expensive initial input observation is outside the SQL transaction. Later
 * renewals use the immutable redacted fact, even after local inputs retire. */
export async function prepareClerkCreation(prisma: Database, config: ServerConfig, active: Active, keys: string[]) {
  if (keys.length !== 1 || active.kind !== "v1") return undefined;
  const resource = active.binding.resources.find(value => value.key === keys[0]);
  if (!resource || resource.kind !== "clerk-test-user" || object(resource.metadata).createdByTask === true) return undefined;
  const selected = scope(active, resource), where = eventWhere(active, resource.id), existing = await prisma.runtimeMetadataEvent.findMany({ where, take: 2 });
  if (existing.length > 1) throw new Error("Original Clerk creation fact is ambiguous");
  if (existing[0]) return { fact: Fact.parse(JSON.parse(existing[0].value!)), existing: { sequence: existing[0].sequence, value: existing[0].value! } };
  const environments = active.binding.resources.filter(value => value.key === "development-env-directory" && value.kind === "directory" && value.purpose === "development");
  const environment = environments[0]?.externalId;
  if (environments.length !== 1 || !environment || !path.isAbsolute(environment) || path.normalize(environment) !== environment
    || path.basename(environment) !== active.task.id || path.basename(path.dirname(environment)) !== "environments") throw new Error("Original Clerk creation has no exact registered environment");
  const metadata = object(resource.metadata), email = z.string().parse(metadata.email);
  const registered = await prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: resource.id } });
  if (registered.taskId !== active.task.id || !equal(finalizationResourceIdentity(registered), finalizationResourceIdentity(resource))) throw new Error("Original Clerk registration changed");
  if (metadata.credentialsFile !== "<envDirectory>/clerk-user.json (0600)") throw new Error("Original Clerk credential receipt has an unsupported location");
  const [script, jwksScript, credentials] = await Promise.all([held(path.join(environment, "scripts/clerk-user.ts"), 16384, false), held(path.join(environment, "scripts/clerk-jwks.ts"), 16384, false), held(path.join(environment, "clerk-user.json"), 16384, true)]);
  if (script.bytes.toString() !== legacyClerkUserScript(active.binding.issueIdentifier, email) || jwksScript.bytes.toString() !== legacyClerkJwksScript) throw new Error("Original Clerk creation script differs from its supported test-only recipe");
  z.object({ userId: z.literal(resource.externalId), email: z.literal(email), password: z.string().min(1).max(1000) }).strict().parse(JSON.parse(credentials.bytes.toString()));
  const relations = await prisma.runtimeSessionRelation.findMany({ where: { targetSessionId: active.binding.sessionId, relationship: "spawned-by" }, take: 33 });
  if (relations.length > 32) throw new Error("Original Clerk delegate inventory exceeds its bound");
  const candidates: Fact[] = [];
  for (const relation of relations) {
    const actor = await prisma.runtimeSession.findUniqueOrThrow({ where: { id: relation.sourceSessionId } });
    if (actor.role !== "delegate" || actor.cwd !== active.binding.worktree || actor.repositoryId !== active.binding.repositoryId || actor.machineId !== active.binding.machineId
      || !actor.acpxRecordId || !/^[A-Za-z0-9_-]+$/.test(actor.acpxRecordId) || !actor.acpxSessionId) continue;
    const snapshot = actorSnapshot(actor, relation), file = path.join(config.acpxStateDir, "sessions", `${actor.acpxRecordId}.json`);
    const observed = await held(file, 16 * 1024 * 1024, false).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!observed) continue;
    const evidence = originalClerkToolEvidence(JSON.parse(observed.bytes.toString()), { actor: snapshot, resource, resourceCreatedAt: registered.createdAt.toISOString(), taskId: active.task.id, environment, instanceId: selected.instanceId, email });
    if (evidence) candidates.push(Fact.parse({ scope: selected, bindingDigest: retirementDigest(active.operation.binding), actor: snapshot,
      evidence: { ...evidence, script: script.identity, jwksScript: jwksScript.identity, credentials: credentials.identity } }));
  }
  if (candidates.length !== 1) throw new Error("Original Clerk creation lacks one authenticated paired execution and registration");
  return { fact: candidates[0]!, existing: undefined };
}

/** Called only after the normal current-operation check and global sharing
 * validation, inside its transaction. No filesystem or provider reads here. */
export async function commitClerkCreation(prisma: Database, active: Active, prepared: NonNullable<Awaited<ReturnType<typeof prepareClerkCreation>>>) {
  const fact = Fact.parse(prepared.fact), resource = active.binding.resources.find(value => value.id === fact.scope.resourceId);
  if (!resource || !equal(scope(active, resource), fact.scope) || retirementDigest(active.operation.binding) !== fact.bindingDigest) throw new Error("Original Clerk creation operation or resource changed");
  const actor = await prisma.runtimeSession.findUniqueOrThrow({ where: { id: fact.actor.id } });
  const relation = await prisma.runtimeSessionRelation.findUniqueOrThrow({ where: { id: fact.actor.relation.id } });
  if (actor.role !== "delegate" || relation.relationship !== "spawned-by" || !equal(actorSnapshot(actor, relation), fact.actor)) throw new Error("Original Clerk creator relationship changed");
  const where = eventWhere(active, resource.id), saved = await prisma.runtimeMetadataEvent.findMany({ where, take: 2 });
  if (saved.length > 1 || saved[0] && !equal(Fact.parse(JSON.parse(saved[0].value!)), fact)
    || prepared.existing && (!saved[0] || saved[0].sequence !== prepared.existing.sequence || saved[0].value !== prepared.existing.value)) throw new Error("Original Clerk creation fact changed");
  const event = saved[0] ?? await prisma.runtimeMetadataEvent.create({ data: { ...where, value: JSON.stringify(fact) } });
  return ClerkCreationWitness.parse({ ...fact.scope, evidenceRevision: event.sequence, evidenceDigest: finalizationDigest(fact) });
}

export function matchesClerkCreation(active: Active, resource: Resource, prepared?: NonNullable<Awaited<ReturnType<typeof prepareClerkCreation>>>) {
  return Boolean(prepared && equal(scope(active, resource), prepared.fact.scope) && retirementDigest(active.operation.binding) === prepared.fact.bindingDigest);
}
