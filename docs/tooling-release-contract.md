# Tooling release and operation contract

DRA-32 defines the implementation seam for DRA-28, DRA-29 and DRA-30.
Status: implementation contract incorporating independent source review,
November 5, 2026. Integration must verify the safeguards below before enabling
activation; the review is not acceptance of unimplemented behavior.
This document specifies new behavior; it does not claim that activation or
adoption is already implemented or deployed. The Drafted implementation plan
remains on the existing [Page](https://chatgpt.com/space/page_d4c2d877a40081918fd357d9f679ebc5).

## Ownership and compatibility

Remote Agent selects immutable code and persists activation and operation
identity. Drafted owns saved tooling-state readers and migrations. Application
database provisioning and schema/history evidence remain DRA-24/25's scope.
Release selection grants no task, provider, delivery or cleanup authority.

Use a committed `.remote-agent-release.json` manifest, separate from the existing
version-1 capability manifest. Version 1 declares:

```json
{
  "contract": "remote-agent.tooling-release/v1",
  "serverProtocol": { "min": 1, "max": 1 },
  "stateFormats": {
    "drafted.runtime": { "read": [1], "write": 1, "preservesUnknown": true }
  }
}
```

`serverProtocol` is an integer protocol range, not a server package version.
Protocol 2 adds exact unclaimed saved-resource observation and producer
confirmation after saved resume, including measured Compose enrollment.
Adapters using those semantics require protocol 2; a protocol-1 server rejects
their preparation before activation. The updated server supports 1 through 2,
so existing protocol-1 bindings and retained consumers continue on their
original releases. The operation envelope and state-format versions do not
change. Deployment compatibility also refuses a rollback that cannot execute
an active or retained protocol-2 consumer.
Every declared writer format must also be readable. Format identifiers describe
persisted tooling data, not application database versions. Add other format
families only after inventorying their actual readers. A candidate must declare
the installed operation protocol and all required observer contracts. Committed
capability entries remain the entrypoint/instruction inventory; using that
inventory internally does not require agents to resolve capabilities.

`write` names the default new-state version. Optional `writeVersions` declares
every version this release may persist, including explicit migrations and
compatible saves of older state; omitted means exactly `[write]`. The list is
nonempty, unique, includes `write`, and is a subset of `read`. For example, a
lossless runtime reader that preserves version 1 and can explicitly migrate to
version 2 declares `read: [1, 2], write: 1, writeVersions: [1, 2]`. Declaring a
version does not authorize a migration: the server still records and validates
the exact affected state/version before any write. An old idempotent write
receipt cannot authorize overwriting a newer recorded format.

Missing release manifests are legacy-only. The bootstrap transition must retain
legacy executables and receipts for reconciliation; it must not pretend that an
old executable enforces the new operation protocol. Normal activation requires a
release-aware candidate. Preserve DRA-21's configuration repair unchanged.

## Durable release selection

Persist a prepared release with `repositoryId`, exact `revision` and `tree`,
canonical immutable `checkout`, committed policy blob ID, validated manifest
and preparation identity (tree, lockfile digest and Bun version).
The server derives these values from the already-configured tooling repository;
an activation caller cannot supply a checkout or executable path.

Owner activation takes `requestKey`, `repositoryId`, exact committed `revision`
and `expectedGeneration`. Prepare dependencies, verify committed regular files,
clean checkout and manifest/protocol compatibility before publishing. A moving
ref, dirty checkout, incomplete installation or unsupported protocol fails
without changing the active selection. Resolve source policy from that same
commit; never import repository-owned configuration into the server process.
Version 1 permits live activation only when the candidate policy blob equals
the running committed policy blob. Different workflows, labels, skillsRoot,
bootstrap or other team policy return `restart-required`, not mixed A policy/B
code. On restart, reconstruct policy from the durable selection's revision;
do not first depend on the moving configured ref successfully resolving.
`restart-required` is a rejection, not a queued activation: no later restart
may promote that candidate implicitly or block unrelated compatible activation.

Persist selection and activation receipt atomically. The selection contains
`repositoryId`, monotonically increasing `generation`, release identity and
activation time. The request receipt binds the key to the complete request
digest and resulting generation. An identical retry returns that result even
after a newer activation; a reused key with a different payload fails. Two
different requests with the same expected generation cannot both win. Startup
reads the durable selection rather than replacing it from the boot config.

Activation uses owner bearer management authentication on the TCP API only.
Do not mount it on the trusted local socket or forward it through task routing;
do not expose it as an ordinary session tool. This is a supported authority
boundary, not an OS security boundary against arbitrary same-user code that can
read credentials. Preparation outside the
transaction may leave an unused checkout after a crash; that is not activation.
There is no automatic checkout deletion in the first implementation. This keeps
legacy, process and uncertain-outcome recovery code available until an explicit
future GC proves it unreferenced.
Lock prepared Git worktrees against pruning. A lock does not make moving the
common Git directory safe: source relocation remains unsupported while retained
consumers exist. Recover abandoned preparation only after proving its exact
attempt no longer owns a process; never steal a live or uncertain lock. Verify
dependency-install receipts as well as committed bytes. Do not prepare/install
tooling inside background observation ticks.

## Operation binding

Persist `remote-agent.tooling-operation/v1` before any effect. The binding has:

* `operationId`, stable request identity and input digest;
* repository, task, primary session and executing turn identities;
* operation kind and any existing compute/finalization/configuration operation ID;
* selected release identity, activation generation and protocol;
* lifecycle status and references needed for recovery and long-lived consumers.

Use existing durable operation IDs where available. The generic binding relates
to them; it does not replace compute offers, claims, cleanup proofs or receipts.
Retrying the same request returns its original binding; incompatible reuse
fails. Persisting a binding is not proof that the provider effect happened.
Unknown effect outcomes stay unknown until the original protocol reconciles
them. A retry must not mint a new operation merely to select newer code.

All executable, instruction, observer/proof, callback, retry and reconciliation
lookups take that binding. They must not independently read the active release.
Background observations of a running resource group use its producing operation
or retained process binding; read-only accounting without an effect binding is
an independently bound observation. Finalization keeps the accepted operation
and existing exact resource authority. Closure is not permission to change code
or discard its history.
An existing group's suspension, reclaim and baseline observation use that
producer too. An admission request or queued offer never advances the producer;
only a confirmed start, resume or configuration transition may do so.
Before a saved resource's first claim, independent collection may use the
latest confirmed admission's exact request binding. Its resource identity,
recipe, task ownership and acknowledged callback history must still match;
an uncertain admission or any prior claim refuses this path. This selects
read-only observer code, never stopped proof or start authority. A successful
saved resume confirms its producer through the guarded `compute-bind` callback;
until then its claimed allocation and pending reader remain conservative.
A failed collection may leave an unclaimed environment `unknown`; the same
exact admission can still observe it, and normal fresh physical reconciliation
determines its state. This exception never covers an uncertain allocation.
Measured Compose resumes instead retain their existing enrollment recipe and
configuration. Bind checks that exact resource and recorded observation plus
the acknowledged enrollment request (or its retained legacy provenance), rather
than treating a measured recipe as a physical-only saved digest.

Before first activation publishes generation 1, atomically persist a stable
bootstrap boundary and legacy bindings for existing environments/resources,
active offers, queued cleanup, pending development intents and finalization
preparations. Retain the exact recorded executable/observer receipt wherever
available. Missing or ambiguous provenance is an affected-consumer diagnosis,
not permission to guess the current configured revision. Later activations do
not move the bootstrap boundary. New unbound rows may never become legacy just
because another activation happened later. Persist lifecycle associations before
effects or in the existing operation transaction; a lost HTTP acknowledgment
must not erase the producer binding.

At a genuinely independent operation boundary, select the current generation
and recheck ownership, pause, admission and applicable delivery authority. A
next-turn instruction refresh selects current instructions without rewriting an
active turn. Existing task pins and capability events remain audit/legacy
reconciliation data; no task-row repinning is part of adoption.
New tasks record the active release as their initial audit pin. Existing
`REMOTE_AGENT_TOOLING_ROOT` retains its historical meaning; use separate
operation identity for execution. Refresh only undelivered queued instructions
through the existing reservation/successor pattern, preserving source identity,
authority and deduplication. Never edit executing/unknown instructions.

The release-aware adapter validates its operation identity and exact running
release against the server before effects. A cached literal path with no valid
binding must fail with the supported next-operation route. An old path may only
continue its retained operation; it cannot self-authorize a fresh operation on
an inactive release. Prompt refresh alone does not establish this protection.
The bootstrap treatment of pre-protocol adapters must be tested explicitly;
they cannot be retroactively made self-validating by changing a manifest.
New-operation callback routes require `x-remote-agent-operation` once the
repository has a release-aware active generation, including when compute policy
is disabled. A binding is matched to task, session, kind, input and selected
release; accepting any valid operation ID is insufficient. Legacy continuation
is allowed only for an exact pre-transition compute/finalization/configuration
receipt, never as a missing-header fallback for a new effect. Keep strict old
observer inputs byte-compatible; binding metadata travels in process context
only for old protocols and in declared new envelopes for aware protocols.
Inventory callbacks before every provider effect: a new guard on just one CLI
command cannot establish legacy protection for the rest of the surface.

Example: operation O1 binds A at generation 4. Owner activates B at generation 5.
O1's observer and unknown-effect retry still load A; a retained process keeps A.
O2 on the same task binds B, and the next eligible turn receives B instructions.
Task, primary/provider session, worktree and saved provider IDs stay unchanged.
A paused task gets no new work from activation.

## Saved tooling state

### Failed identity reservation repair

The owner TCP endpoint `POST /api/tooling-releases/:repositoryId/tasks/:taskId/identity-preparation-repairs`
provides one narrow independent boundary for a defective identity adapter. It
requires the original task to be held paused, its managed family inactive, no
native owner, the exact bound command/input and selected compatible generation.
Only version-1 `drafted.test-identities/test-identities` writes are allowed;
children, retained consumers, account resources, compute environments, later
writers, attempted/unknown accounts and changed ownership refuse. The selected
immutable release's `test-identity-preparation/v1` observer reconstructs the
original CLI input digest and verifies the original private assignment has only
planned dedicated slots with zero attempts. It makes no provider requests.

After fresh proof and a transactional recheck, the server retains the original
binding and writes, records `identity-preparation-failed` as its terminal
evidence, and binds one linked successor on the corrected release. This is a
recorded failure, never successful preparation or account-absence proof. The
owner request key replays the same receipt after lost acknowledgment; changed
payload refuses. The successor is returned for the original primary to resume
with the original command arguments and `REMOTE_AGENT_TOOLING_OPERATION` set
to that successor ID. Normal pause, ownership, state and provider checks still
apply. The API does not unpause, dispatch, repin a task, replace an account or
delete the reservation. Original pins and immutable release history remain.

This source addition requires a compatible paired rollout before use. It is not
a generic operation replacement API and cannot recover uncertain provider writes.

DRA-30 inventories current runtime/configuration/compute/cleanup receipt readers
and adds validated format handling at their shared boundaries. Prefer reading a
compatible existing version without rewriting it. Do not bump version 1 only
to record a newer tooling release. Unknown fields must not be silently stripped
and then persisted, especially DRA-24/25's adjacent evidence.
The existing version-1 runtime parser strips unknown top-level fields and
rejects unknown nested compute fields. Mark legacy readers as
`preservesUnknown: false`. The first release-aware reader preserves extension
fields at writable boundaries while validating all known authority fields.
If adding data that a legacy writer would discard, use a new write format
(version 2) so the old reader refuses, and defer that migration while a legacy
consumer remains. Do not silently claim old version-1 writers are compatible.
Inventory server-held compute observations/traffic state and the retained
traffic daemon journal alongside file receipts; these also cross code releases.

Where a format transition is actually required, use the existing task lock and
private atomic state writes. A migration receipt records format family,
from/to versions, original input digest, output digest, migration identity and
operation/release identity. Record intent before replacing state; recovery
distinguishes unchanged input, fully committed output and unexpected bytes.
The same migration is idempotent. An uncertain rename/acknowledgment is read
back, not repeated blindly. Reject corruption and unknown versions with a
specific affected-operation diagnosis before any provider effect.

Migration preserves exact task/session/worktree/resource identities, provider
IDs, pending outcomes, application data and setup/fixture completion. It never
replays provisioning, fixtures or database migrations. DRA-24 owns Neon parent
and uncertain-create evidence; DRA-25 owns schema comparison evidence. Those
fields are preserved, not interpreted as new release or migration authority.

Example: migration M stages input digest X to output Y, then acknowledgment is
lost. Retry accepts Y only if its receipt verifies the exact completed migration;
X may resume the same migration; any third digest requires reconciliation.
An existing pending Neon create remains pending in every case.

Rollback changes future release selection and never rewinds state. Activation
checks declared readers against known committed state formats. Each operation
also validates its actual state before effects. If a state migration would
invalidate a retained A operation/process, defer that migration for the affected
state until its consumers finish or provide a compatible reader strategy.
Neither activation nor unsupported state creates a global task pause.
Actual written-format evidence outlives completed operation bindings. Checking
only the latest active manifest would permit A(v1) -> B(v2 writes) -> C(v1-only)
after B completes. Register the required format before a write and preserve that
evidence for rollback checks. Candidate potential writes do not globally block
activation: enforce incompatible migration/write restrictions on the affected
task/state while unrelated operations continue. Missing required families are
not silently treated as compatible.

## Writer map and integration order

### Frozen source seam for parallel implementation

`types/tooling-release.ts` defines the shared wire values. DRA-28 implements
`apps/server/services/tasks/tooling-releases.ts` with these exports (object
arguments; `prisma` is the server Prisma client and `config` is ServerConfig):

* `getActiveToolingRelease({ prisma, config, repositoryId })` returns
  `ToolingReleaseSelection | null`; null means no supported activation yet.
* `activateToolingRelease({ prisma, config, repositoryId, requestKey,
  revision, expectedGeneration })` returns `ToolingReleaseSelection`; expected
  generation 0 means no persisted selection. The route authenticates separately.
* `bindToolingOperation({ prisma, config, taskId, sessionId, turnId, request })`
  returns `ToolingOperationBinding`, atomically choosing the active selection
  only for a new request. `request` is `BeginToolingOperationRequest`. Missing
  selection is a precise error, not silent use of a boot pin. Same task/request
  key and identical stable request returns the retained binding regardless of
  current selection. Persist identity before returning; no provider effect.
* `readToolingOperation({ prisma, operationId })` returns the binding or null.

The binding service checks exact task/session/repository identity; DRA-29 adds
current operation-specific pause/admission/delivery authority and continuation
rules. DRA-29 owns the protocol adapter routes and lifecycle association, with
`POST /api/sessions/:sessionId/tooling-operations` taking the begin request and
returning `{ binding }`; no request accepts executable paths or release IDs.
`GET /api/sessions/:sessionId/tooling-operations/:operationId` returns that exact
owned binding. These endpoints are not themselves compute/cleanup authority.
The CLI derives its actual immutable release from its checkout and compares it
to the returned binding before effects. An old release cannot take a new B
binding and execute A. Retries must reuse the durable operation identity.

An `adapter-command` root binding fences a complete adapter command before its
first effect, including commands with no server effect callback. Callback begin
requests carry `parentOperationId`, distinct from `existingOperationId` (which
continues to name a compute/finalization/development record). The server reads
and validates the parent inside the binding transaction and derives the child's
release, generation and protocol from it, never from the active selection.
The parent must be an unfinished command binding owned by the same task,
session and repository; an unknown outcome requires reconciliation before any
new child effect. Parent identity is part of idempotency comparison. No caller
chooses a release by sending a revision or path. Existing exact operation
references and their owning bindings must agree with this lineage; a parent
does not grant permission to take over another operation or bypass authority.

Persist the parent ID on the callback binding and return it on the wire
(absent/null means a root binding). Preserve the binding through retries and
observer/process lifetime. A completed parent cannot spawn fresh callbacks;
an exact completed-child replay remains subject to its existing protocol's
evidence and current authority checks. Completion of a command must not erase
retained environment/cleanup consumers. The regression boundary is activation
of B after command A is bound but before its **first** callback: that callback
must still execute A, while the next independent command selects B.

DRA-30 implements Drafted's wire consumer in a new module; DRA-29 owns server
validation of `x-remote-agent-operation`. Operation kinds and callback-to-kind
mapping must be exhaustive for the affected paths and tested; input digests are
canonical JSON SHA-256, never hashes of incidental serialization order.
DRA-28 leaves externally callable activation unavailable until integration
enables protocol support after all DRA-29/30 consumers are verified. This is an
internal implementation completeness guard, not another per-task capability.

DRA-28 also owns boot policy selection (`lib/config.ts`, `lib/tooling-source.ts`,
`apps/server/server.ts`) and activation mounting in `app.ts`; DRA-29 owns its
operation-route mounting in `routes/index.ts` and the desktop management
consumer (`management/development-control.ts`). The primary owns this shared
type file after handoff and arbitrates interface changes. DRA-30 does not edit
`paired-release.ts`; its retirement/conversion is a DRA-33 handoff requirement.
No existing live release operator is invoked or widened here.

| Lane | Exclusive files and seam | Integration |
| --- | --- | --- |
| DRA-27/32 primary | This contract; integration/acceptance records; final shared wiring after worker handoff | Publish contract and review corrections first; integrate only reviewed ready commits |
| DRA-28 worker | New release persistence/service/routes/tests; `services/tasks/tooling.ts`; new `prisma/schema/tooling-release.prisma` and its migration; shared release/operation storage primitives | Freeze exported primitive signatures before DRA-29 binds consumers; DRA-28 alone generates the shared Prisma client |
| DRA-29 worker | New operation routing/service/tests; `tooling-capabilities.ts`, `tooling-compatibility.ts`, preparation/observer/finalization consumers and instruction composition | Consume DRA-28 primitives; no independent edits to activation persistence/schema; return shared workflow/runtime wiring as a bounded patch if another lane owns it |
| DRA-34/35/36 admission correction, same DRA-29 writer | `compute-admission.ts` and focused tests; bounded scheduling in `services/sessions/inbox.ts`; existing baseline/observer accounting | One writer across reservation and collection changes; no dependency on completion of the full DRA-27 redesign. Preserve DRA-9 ownership of provider lifecycle wiring; integrate its reviewed artifact before overlapping edits |
| DRA-30 worker | Paired Drafted worktree: new state-format/operation-validation modules and focused tests; runtime reader integration, release manifest and adapter guard | Preserve DRA-21 repair; coordinate runtime-config/runtime/CLI field overlaps with DRA-23 before touching them |
| DRA-23 existing primary | Neon provisioning/recovery, runtime recipe/provider fields and application schema evidence on its own branch | No edits to that branch; agree additive field contracts through linked issues; DRA-27 integrates reviewed ready changes, not live completion |
| DRA-20 independent source lane | `workers/product/workflow/worker.ts`, `continue-plan.ts` and launch-intent helpers/tests | DRA-27 does not edit its branch; integrate its reviewed commit before applying any overlapping next-turn refresh patch |
| DRA-9 independent source lane | Terminal guards in `services/sessions/runtime-registry.ts` and provider completion tests/wiring in `transports/acpx/session-runtime.ts` | DRA-27 does not edit its branch or clear the old family pause; serialize any next-turn wiring after its reviewed commit |

DRA-28 and DRA-29 may share the assigned Remote Agent worktree only with this
disjoint file map. DRA-30 writes only the explicitly assigned paired Drafted
worktree. Actual delegate IDs/cwds belong in issue debugging evidence; a queued
worker is not reported as running. Shared files have one writer at a time.

After contract review, all three implementation boundaries proceed in parallel.
DRA-31 then runs the actual combined lifecycle on a new isolated real server,
private DB and loopback socket/port with synthetic tasks and retained data.
Tests cover A-running/B-active, stale adapter refusal, lost acknowledgment,
generation race, crash/restart, format interruption, unknown effects, rollback
readers, owner pause/revocation, exact cleanup and unchanged task/session IDs.
Record the PID across activation. Run exact-head required checks on supported
hosted runners where available; retain failed/time-limited results honestly.

DRA-33 alone owns shared bootstrap deployment. DRA-27 supplies reviewed paired
commits/trees, protocol/state-format evidence and rehearsal results. Merged,
source-ready, isolated verified and deployed are distinct states.

Once a durable selection exists, server deployment/rollback must preserve its
protocol instead of falling back to a pre-selection server's boot ref. The
primary owns `management/tooling-deployment.ts`, deploy guards, doctor selection
diagnostics and `lib/tooling-server-protocol.json`. Automatic database rewind is
refused after activation: it could erase operation history while external
effects remain. DRA-33 owns coordinated compatible recovery. The old Drafted
paired-release operator must not be used to edit refs and restart as a substitute
for durable selection; its replacement/retirement is a cutover prerequisite.

## Adjacent admission correction (DRA-34)

Reserve verified available capacity before notifying the original primary.
Dispatch and slow baseline checks must not consume an offer-acceptance timer.
Persist exact assignment/startup identity and reconcile retries, unknown outcomes
and legacy in-flight states. A deadline alone never frees started or uncertain
compute. Owner pauses, conservative charges, managed cap and environment IDs
remain binding. DRA-35 owns this reservation behavior; DRA-36 keeps collection
independent from ordinary inbox delivery, bounds overlapping passes, filters
ineligible waiters before physical scans and diagnoses exact blocked groups.
These are one existing admission writer's assignments, not another product
writer. DRA-37 owns combined isolated real-server and app/browser acceptance;
DRA-33 retains the single held shared rollout.

Before scheduler edits, an isolated SQLite reproduction delayed the baseline
refresh by 65 seconds using a test replacement for the collector. With a durable
turn-start event, the offer remained queued with no delivery or reservation
during the refresh, then expired after 65,728 ms with delivery and claim still
unset (one test, ten assertions). This verifies the delivery-expiry path using
real elapsed time; it is not a live-observer measurement or acceptance of the
repair. Preserve it as a regression scenario alongside DRA-37's real-server
tests. Evidence and remaining acceptance belong in the paired Drafted
`docs/acceptance.md` and linked issues.

### State evidence response contract

The paired state client and server use the response interfaces in
`types/tooling-release.ts`. Read evidence is
`GET /api/sessions/:sessionId/tooling-operations/:operationId/state?family=...&scopeKey=...`.
It returns `{operationId, taskId, family, scopeKey, version, source, consumers}`;
`source` is `recorded`, `legacy-assumed` or `none`. Each consumer is
`{operationId, format}`. A proven pre-protocol consumer has a null format and
an identity `legacy:<consumer-id>`; an unresolved or ambiguous executable
provenance instead refuses this state with 409, never an empty inventory.
The inventory includes unfinished release-bound operations and retained legacy
consumers that can read the affected state, not just the active release.

Before every file write, the client sends
`POST /api/sessions/:sessionId/tooling-operations/:operationId/state-writes`
with `{family, scopeKey, version}`. The result is
`{operationId, taskId, family, scopeKey, write}` where `write` contains the exact
version, writer's preservation flag, operation/release IDs and durable sequence.
The client validates all echoed identities and version before changing bytes.
Both routes require the matching operation header and derive task/repository
from the stored operation. They recheck current owner authority and lifecycle;
callers cannot choose another task or a release. Scope is the operation's
resource key, or `task` for task-global state; arbitrary file paths do not become
new state scopes. Registration delegates to the atomic per-state checks and
retains the existing structured error codes. These are frozen wire shapes for
parallel implementation; this section does not claim the routes are wired yet.

### Command settlement and retained consumers

A resource or observer can outlive its creating callback and command. Remote
Agent retains a separate durable consumer with the exact producing operation
and state scope. Pending/uncertain consumers retain reader requirements; only
verified replacement, no-effect, stopped or absent evidence resolves them.
Completing a command never resolves its children or consumers. Server-started
continuations derive an `adapter-command` fence from a confirmed retained
consumer, with `retainedConsumerId` recorded separately from command parentage.
Public begin requests cannot choose this field or an arbitrary release.

A successful adapter command posts
`/api/sessions/:sessionId/tooling-operations/:operationId/settlement`, with the
matching operation header and `{requestKey,inputDigest,outcome:"completed"}`.
The server checks the stored command identity, current ownership, and durable
child/consumer outcomes; unresolved effects cannot be declared successful.
The response is `{binding,outcome}` with the exact completed command binding.
The client validates it before forgetting the retry journal. A lost response
retries the same settlement and identity. A failure or uncertain command result
retains the journal for reconciliation, never sends a success settlement.

`outcome:"no-effect"` is an explicit abandonment path, accepted only for a
bound command with no child operations, state writes or retained consumers.
The server records evidence before completion and refuses key/outcome reuse
with changed meaning. A completed parent cannot spawn new children; its exact
existing child retries remain subject to normal authority and idempotence.
Read-only commands must either settle their fence or use a classified read-only
path, never leave a permanent unfinished command merely from inspecting status.

### State scope and uncertain registration

A command fence with a null resource key covers its owning task's state scopes.
It already counts as a reader of every state on that task while unfinished.
Direct runtime commands use their exact `runtime-<purpose>` key; commands that
can reach several resources use a task-wide fence and retain exact keys on their
callback children. Keyed operations can access only their own resource scope or
task-global state. Every route derives the task from the binding, checks current
authority and the release's declared formats, and accepts no task or file path
override. This adds no compute, provider or cleanup authority.

A structured 4xx state-write rejection means registration definitely did not
commit. Once registration may have committed, a later authority change or
receipt mismatch returns an outcome-unknown failure (5xx), even when the adapter
must be prevented from writing. The adapter keeps its migration journal and
reconciles using the same operation; it must not withdraw intent on that result.

These seams are integrated and independently audited. Source activation is
enabled for normal isolated lifecycle verification; the route still requires
owner bearer authentication and is absent from trusted sockets. Combined
lifecycle acceptance remains required, and DRA-33's live cutover is held.

### Closed legacy resource cleanup compatibility

Baseline comparison confirms a distinct supported path: a closed, unpaused
legacy task without prepared finalization, cleanupRequired, finalization v2 or
non-reference retention may still reconcile, stop and release eligible existing
resources. Its adapter performed those effects and recorded resource receipts;
closed browser/local-service stop authority and new work were already refused.
The release protocol must preserve this path without granting a task-wide fence
or treating closure alone as cleanup permission.

Use operation kind `closed-resource-release` for exactly one existing resource.
The public begin shape is unchanged: `resourceKey` is required and `inputDigest`
is the canonical digest of `ClosedResourceReleaseInput {key,action}`. The server
matches that digest against the three allowed actions for the stored key,
validates the exact original task/session/repository/source ownership, settled
family, owner pause, existing receipt and baseline retention restrictions, and
selects the active immutable release. No parent or existing-operation override
is accepted. Original resource ownership and all physical cleanup checks remain
binding; this code selection creates no provider authority.

The client binds immediately before each eligible resource action, including
manual stop/release/reconcile commands and sequential upkeep. It may use the
existing settlement endpoint with the same request key/digest and durable
outcome rules. This operation cannot parent callback operations, start compute,
resume resources, obtain browser/local-service execution authority, or enter
finalization. Its only resource update is for the same exact existing key and
identity. Runtime receipt reads/writes remain format-checked for that resource's
scope; task-global access and format migration are refused. A cleanup write may
retain the recorded format version, never raise or rewind it. Unknown effects
keep their operation and journal for reconciliation.

Prepared-finalization resources retain their existing `finalize:<taskId>`
lineage. An already-finalized sweep with no eligible effects may return its
read-only result without opening a fence. It must recheck eligibility before
any effect rather than turn a stale empty inventory into permission.

DRA-29 owns server kind/admission/receipt/state/settlement enforcement and focused
real-route regressions; DRA-30 owns the paired per-resource wrapper and client
regressions. No schema migration or new wire field is required. Root owns this
contract and independent integration review. The compatibility correction has
passed real-route runtime, preview and crash-recovery checks. Source activation
is enabled for the isolated lifecycle rehearsal; no live activation or shared
deployment is authorized by that source change.

## Recovering a refused Platform configuration

The owner-only TCP endpoint
`POST /api/tooling-releases/:repositoryId/tasks/:taskId/configuration-refusal-repairs`
handles the known local validation refusal before a configuration journal or
callback was created. It is unavailable over the session socket. The request
names the original command, exact input digest, selected generation and original
`runtime configure` values (`task`, `config`, `state-directory`, `purpose`).

The original task must be held paused and its whole provider family inactive.
Its command must remain bound, with only its own version-1 runtime progress
writes, no children or retained consumers, and no later writer. The selected
immutable reader must advertise `runtime-configuration-refusal/v1`. It checks
private unchanged inputs, the exact validation error, original prepared runtime,
provider/container/network identity, source and coverage. Only the missing test
API public key and obsolete Platform home readiness correction qualify. It does
not edit the app, providers, saved state, task pin or original request journal.

One transaction records `configuration-validation-failed` on the original
command and creates a linked successor with the same input on the corrected
release. The receipt freezes only acknowledged admission/configuration
predecessors; uncertain callbacks/readers refuse. This successor can continue
only that runtime and offer, through the ordinary locks, capacity admission,
stopped-app configuration observer and ownership guards. It cannot adopt an
unrelated or later producer. Exact endpoint retries return the same successor,
including after resume; changed requests and competing repairs refuse.

Resume the original primary using the returned immutable release and
`REMOTE_AGENT_TOOLING_OPERATION` with the original arguments and file bytes.
Keep the old journal and failure history; do not mint a replacement request key,
relabel the old operation as success/no-effect, or repin the task. The normal
command settles its successor after verification. Persisted handoff receipts
require `configuration-refusal-recovery/v1`, including after completion, so a
server rollback that cannot read the lineage is refused before service changes.

## Retiring a superseded failed startup

A health-failed `runtime up` or `runtime configure` can leave its command open
after its callbacks were acknowledged. A later successful configuration does
not make the earlier command successful. Ordinary fresh-offer adoption may
record `runtime-command-superseded` only after proving that the original turn
ended before the successor, every callback has a definite outcome with its
latest attempt acknowledged, and all its readers resolve to the same stopped
offer. Unknown callbacks, unrelated state writes or children, changed runtime
identity, missing configuration receipts and still-live readers refuse.

The later admitting command must have successfully completed an exact atomic
configuration transition of the retained runtime. Its receipt, original source,
recipe, resource and reader chain remain authoritative. Normal adoption still
requires terminal earlier offers, a fresh stopped observation of the current
resource, current source ownership, an unpaused task and the normal capacity
claim. Read/prebinding checks are pure. Only the final adoption transaction,
after taking its write lock and rechecking the evidence, retires the old parent
and acknowledged callbacks together. Failures roll back the whole change.

`runtime-command-retired` records the original parent, child identities and
statuses, resolved readers and successor transition sequences. Request keys,
digests, task pins, failed history and providers are unchanged. This is neither
command success nor a no-effect settlement; a later success settlement of the
retired command is refused. The saved receipt requires
`runtime-command-retirement/v1` even after completion, preventing an older
server from silently misreading the result during rollback.
