# Cleanup uses persisted delivery authority

The cleanup lifecycle binds the existing `finalize:<taskId>` preparation to
an immutable local cleanup operation. It does not replace the original
preparation, completion contract, verification, retirement grant, retained
evidence proof or tooling pin. A current Linear status is neither new cleanup
permission nor a revocation of an already accepted delivery.

`prepare-finalization` accepts `cleanup: true` for an existing v1 preparation,
or creates the normal v1 preparation from an already accepted owner contract,
matching verification and independently observed exact delivery. The latter
binds source identity without requiring current Merge; it refuses a differently
keyed old preparation or explicit revocation. Full preparation verifies the current original worktree/Git
registration and saved archive bytes, establishes any legitimate saved-archive
proof before freezing the operation, and compares the local authority again in
the transaction. It never performs a destructive action.

`authorityOnly: true` requires that bound operation. It checks the original
primary, owner pause, task/pin/resource identity, current accepted contract and
verification, explicit 183/193 revocation and immutable retention references
using the local database. It does not call Linear, GitHub, Git or filesystem
hashers. Physical adapters retain their exact held-target and ownership checks.
Full resource boundaries and confirmation still inspect physical results and
retained contents. A changed proof, target or pin cannot be bypassed by minting
another request key or silently rebinding an existing operation.

Explicit cleanup responses add `cleanup: {operationRevision, operationDigest}`.
The client must freeze this server witness before accepting a non-complete
phase. The original preparation and ordinary no-flag v1 responses stay intact.

The task-bound prepare/confirm routes resolve the primary directly. Drafted's
cleanup requests use these routes, avoiding a full task projection before every
native removal batch. Existing session routes and old receipt shapes remain
available. Registry updates cannot add targets, change frozen identities or
resurrect released resources; a paused task may still record a same-state stop
observation without granting deletion authority.

Confirmation atomically queues a fixed cleanup report in the existing
issue-update store. The cleanup-aware finalizer closes after confirmation and
attempts reporting independently. Existing preparations have no frozen source
version, so their report is comment-only and never changes Linear status.
Closed-task retries accept only that original task/issue/connection, confirmed
preparation, comment UUID and body. They reconcile a lost response without
repeating cleanup. Pending publication never becomes a claim that publication
succeeded, and a pause/revocation still prevents a new reporting effect.

Linear can return HTTP 200 with a structured `Entity not found: Comment` error
when the saved report UUID has not been published. The shared identity lookup
treats only that exact single-error, null-data response as absence. Authentication,
permission, network, malformed and partial-data failures remain errors. Reporting
then uses the original UUID and body; reconciliation requires the exact issue,
body and top-level comment identity. It never reopens a closed task or repeats
cleanup. Disposable GraphQL and control-route tests cover first publication,
lost create responses, restart retry and mismatched identities. The original
DRA-8 lookup was inspected read-only; this change does not claim live publication.

The shared destroy CLI and dependency-aware adapter scheduling use this same
operation. A merely Done task is not accepted delivery authority. Older external
deliveries require their authenticated adoption and independently observed exact
delivery/preservation plan before this operation can bind them.

Validation includes real Git/SQLite fixtures and the actual Drafted control
client over a disposable Unix socket into the server routes. The latter binds a
retained 8 MiB archive and performs 128 renewals within a real 10-second deadline
with no task GETs, including database/client reconnection, pause rejection and
full-boundary rejection of changed retained bytes. Run with
`DRAFTED_INTEGRATION_ROOT` pointing at the matching Drafted checkout.

The current client exposes `drafted task destroy --task ID --socket PATH` as an
entry point to the existing finalizer; `upkeep finalize` uses the same operation.
Automatic expired upkeep selects locally accepted merge contracts with matching
verification and queues the **original primary's existing durable inbox**. It
never runs destructive cleanup alongside another turn. The server resolves the
configured immutable cleanup compatibility capability, preserves the old task
pin, and supplies the exact adapter/task/socket command. First preparation still
independently verifies delivery; scheduling is not cleanup authority. Paused
tasks, changed original ownership and revoked decisions are not scheduled.
Closed operations retry only their pending frozen report.

Each maintenance pass has an idempotent request receipt; concurrent passes reuse
an outstanding synthetic cleanup instruction. A deferred/cancelled request
replays unchanged, while a later pass can schedule a new attempt after genuine
work finishes. Before dispatch, genuine queued work takes precedence without
being cancelled or acknowledged. Automatic operations persist their inbox
origin and require exact instruction/execution/lifecycle correlation on every
renewal. Active delegates or another unsettled task instruction halt further
effects. Automatic close repeats the inbox check in its transaction, preserving
a follow-up that arrives after physical confirmation. The current cleanup turn
returns and the existing runtime delivers the follow-up; there is no new lease
or executor. These guards serialize agent turns, not arbitrary processes outside
the registered task. Exact physical target checks remain required.

Resource results are recorded against the same operation. The server validates
keys and the operation epoch, caps/redacts diagnostic text, and derives terminal
progress from its resource receipts and retained-archive proof. A reported
success cannot release a resource. Unresolved required resources prevent closure;
progress remains inspectable after restart.

The v1 directory-evidence and installed-dependency paths accept the same bound
cleanup witness in a waiting phase. Directory capture keeps its independent
archive/inode/inactivity checks. Native dependency batches use the cheap local
authority request, while full entry/completion checks still observe Git and
preservation. Existing dependency journals exclude only the additive operation
witness from their original preparation digest, so interrupted removals resume
without replacing the journal or original preparation.

The actual CLI/control integration removes 2,200 disposable dependency files,
closes through the real server automation route and retries offline reporting.
A separate real 2,300-file native test resumes an old journal and asserts that
batch checks cannot call full task projections, provider preparation or Git.
The retained-backup/directory fixture verifies pause before capture, same-proof
retry, unchanged original receipts, retained SQL bytes and an unresolved foreign
provider resource. The integrated stop-first dependency scheduler preserves
independent progress after adapter failures. Before first operation binding,
legacy native reconciliation observes supported source consumers and writes only
private proof plus observation fields on their existing receipts. Unsupported
sources remain unresolved. A real-process fixture confirms this hook precedes
preparation without signals, new resources, pin changes or saved-data loss.
No live teardown was performed by these tests.

## External delivery continuation

An adopted external delivery uses the same `finalize:<taskId>` operation with
`finalizationVersion: 2, cleanup: true`. The original v2 preparation remains
byte-for-byte unchanged; the cleanup witness is a response overlay. Accepted
external bindings, their owner history and independent delivery observations are
the local authority references. A present-day acceptance may have no historical
merge contract or verification, and its exact cleanup branch can differ from the
recorded task branch. Neither identity is rewritten and no aggregate merge is
invented. First preparation still checks the actual Git correspondence, provider
delivery, preserved original work and the complete resource plan.

After adoption, current Linear status and task waiting/complete phase do not
revoke cleanup. Explicit revocation, owner pause, changed binding, original
ownership, pin or resource identity do. Full boundaries continue to inspect
providers, retained bytes and physical targets; `authorityOnly` renewals use only
the common local epoch. Historical acceptance reuses its frozen owner-comment
lineage instead of fetching Linear again; current provider checks and explicit
local revocation remain mandatory. Retained references come from the exact frozen v2 plan.
A Released adapter receipt is not evidence of absence: confirmation independently
observes every physical target before recording the per-resource proofs and the
cleanup report in one transaction. Unknown or unsupported targets remain blockers.

Automatic requests reuse the original inbox with an external-binding marker;
they do not manufacture a completion contract. The same pending-work, active-turn
and pause guards apply. Confirmation queues a comment-only report that names each
actual reviewed head and merge. Original unfinished bytes are described as
preserved, not shipped. The report can retry after verified closure, with its
original comment identity/body, without overwriting a newer source status or
repeating cleanup.

`external-cleanup-lifecycle.test.ts` covers first/existing preparations, source and
phase changes, original branch correspondence, revocation and observation races,
128 real Unix-control renewals under a ten-second deadline, physical adapter
absence, confirmation/report transaction rollback, actual closure routing and
closed reporting retries. It uses only disposable Git/SQLite fixtures and fake
provider observations. With `DRAFTED_INTEGRATION_ROOT` set, the actual Drafted
finalizer/control client executes the clean correspondence case, retains its PR,
closes through the server route and retries offline reporting after restart.
Live older tasks still require matching concrete resource
adapters and exact ownership; this continuation layer does not exempt their
unhandled records.
## Read-only cleanup history

Task, task-list and session-task GETs expose `cleanupHistory` independently of
whether an automatic cleanup turn is executing. This read-only view validates
saved operation/preparation bytes and original identities, and lists the bound
resource receipt states. Pausing, revocation, or changed current ownership keeps
that history visible alongside `cleanupBlocked`. Missing or changed resource
identities are `unknown`, not successful removals; additional current resources
are listed as unbound. Existing `cleanupProgress` remains the saved diagnostic
record with current identity-checked states. When no progress event exists, the
API does not invent one.

`cleanupHistory.readOnly` is always true. It contains no prepared cleanup
witness, cannot schedule work, and grants no adapter authority. The existing
`cleanupOperation` field retains its original execution checks for compatibility
with clients that use its presence to select lifecycle behavior. A disposable
actual-client regression verifies that idle and paused history cannot enable
dependency removal. Full preparation, mutation, confirmation and reporting
guards are unchanged. The DRA-199 acceptance fixture also covers active/idle
transitions, restart, revocation, changed resource/primary identity and corrupted
preparation links through the real GET routes.
# Frozen older preview receipts

An older v1 operation can contain a named preview whose account and zone are
stored as `account`/`zone`, whose DNS ID is in the structured `routeResult`, and
whose endpoint carries only `publicUrl`. The current preview adapter reads the
provider, then records canonical fields before deletion. Previously that first
receipt update failed because the operation validator required canonical fields
in the original frozen record.

The validator now derives those fields only from one exact saved association:
the hostname, tunnel UUID, hex account/zone, loopback source and same-purpose
endpoint, plus the structured CNAME record when present. It accepts only equal
canonical additions and the existing terminal annotations. When the original
association has no DNS ID, only null is accepted; discovering a new ID does not
expand the frozen scope. Other metadata, shared ownership, resource identities,
pause/revocation checks and original preparation/operation bytes stay bound.
New retirement grants still require canonical discovery before authorization.

The UUID-external-ID format is also supported for an already-frozen operation:
its tunnel records an absolute `config` and loopback `source`, its endpoint's
structured `tunnel` repeats the UUID/hostname/config, and its one DNS receipt
records account, zone, CNAME target and creation result/DNS ID. The validator
requires the exact three same-purpose records with matching source/config and
no duplicate physical aliases. Optional nested identity/config/source aliases
must agree. An explicit legacy `endpoint.tunnel.shared: true`, which the current
client cannot preserve through this format, and malformed/conflicting sharing
flags are refused before discovery acknowledgment or deletion. It does not infer
missing IDs from prose or provider discovery. The existing adapter still independently checks provider
ownership and absence; this compatibility only validates its equal discovery
annotations and ordered terminal receipts. Frozen preparation and operation
bytes stay unchanged, and pause, revocation and original-primary checks still
apply. This fixes the original DRA-71 first receipt-write refusal after its
credential repair; the live cleanup result remains separate from source tests.

The disposable HTTP tests cover development with a recorded DNS ID, review with
no DNS record, conflicting associations, premature endpoint completion and
retry. The real Drafted adapter also runs through the Unix control route with a
mock provider, including one lost DNS deletion response. The read-only DRA-80
check matches all four original records without submitting a receipt or provider
mutation; live removal remains an original-primary acceptance step under
DRA-127/DRA-227.

# Accepted pull request history in older cleanup

A v1 cleanup can retain its one original Ready pull request receipt when the
unchanged preparation records that exact canonical GitHub URL as observed,
matching the accepted head and merged. The already-bound cleanup operation must
still contain the exact original resource identity and metadata. Historical
draft, CI or head annotations are left intact; they do not replace the accepted
delivery proof. Missing, changed, duplicate, unrelated or unbound references do
not qualify, and every physical resource keeps its existing removal checks.

The existing `finalizationRetention` task projection has an additive `version: 1`
variant containing exactly one `retain-reference` / `pull-request` entry. It
binds task, primary, request, preparation revision, operation revision/digest and
the retained-array digest; confirmation revision appears only after confirmation.
The reference's `deliveryId` is `finalizer:<taskId>:<preparedRevision>`, a locator
for the original preparation, not a new delivery event. Existing confirmed v2
projections are unchanged. Prepare, confirmation, progress and closure use the
same validated operation; no preparation, operation or resource row is rewritten.

The genuine v1 Git fixture first reproduced confirmation refusing the Ready PR.
It now projects retention before removal, confirms and retries after ordinary
clean-worktree removal, and closes with the PR and old event bytes unchanged.
An opt-in actual Drafted/Unix control-route fixture also removes the real Git
worktree, loses the committed confirmation response, then resumes and closes
without a second removal or changing Ready history. Negative cases cover
ambiguous aliases, unrelated resources, missing binding,
identity changes, unmerged or malformed delivery, pause and revocation. Live
acceptance remains with the original task owner; these tests create no provider
resources or live cleanup effects.

## Legacy Compose aggregate compatibility verification

The optional `DRAFTED_COMPOSE_INTEGRATION_ROOT` fixture exercises the configured
tooling client's existing resource release route against a genuine server v1
preparation and operation. Object `{id,name,subnet}` and name-only network records
remain in their original aggregate resource. The client resolves names only
through exact recorded owned-container dependencies, records private member
lifetimes before effects, and uses the unchanged compact authority route.
The pair verifies a late pause, interrupted removal and lost aggregate receipt
response with no new child records, metadata rewrite or preparation/operation
event change. It uses disposable provider objects, not host Docker resources.
No server runtime contract was added for this compatibility path.

The opt-in macOS `DRAFTED_PROXY_INTEGRATION_ROOT` test in `cleanup-lifecycle.test.ts` runs the real Drafted recorded-proxy stop through the Unix task registry against a genuine v1 preparation and cleanup operation. A late database owner pause prevents signaling; a lost signal response reuses the exact private native proof without another signal. The original raw preparation/operation events, immutable resource identities, enclosing Compose receipt and saved data remain unchanged. The fixture process is disposable; it does not query or mutate a live task or provider.

DRA231 adds a whole-finalizer case under the same opt-in. It calls the actual client `finalizeTask` through normal upkeep and Unix routes with two bound Compose groups, a Released predecessor, three endpoint aliases, a real disposable proxy and an explicitly retained PostGIS source. Independent review cleanup progresses after observation-only reconciliation; the proxy stops once and its endpoint receipts become Released. Lost removal and Released acknowledgments reuse the same journal and proof bytes. The retained source and group, all original receipt identities, raw preparation/operation and Git worktree remain intact, with no confirmation or closure. This catches the orchestration failure missed by direct resource-release tests; no server production contract or live-task state changes are included.

The retained-spatial variant of that whole-finalizer test binds the existing migrated cutover receipt and freezes the protected spatial container/volume/network in the client's private member journal. Four other development containers and three volumes are removed, while the retained source stays stopped and all original resource metadata and preparation/operation bytes remain unchanged. A lost partial removal and an independent review Released response recover through normal Unix routes. The existing v1 progress remains Ready/blocked and confirmation/closure do not occur; this test does not introduce a retained disposition or change server authority.

DRA-173 adds optional visible progress through the existing issue publisher and confirmed report outbox. `cleanup-status` saves only reporting intent; it cannot bind an operation or grant effects. The final report captures a reference only when that intent predates confirmation. Existing reports remain comment-only. Missing configuration and reporting failures leave physical cleanup independent, while source serialization and confirmed-start supersession prevent an obsolete Cleanup update from following final Done. Owner changes are preserved. No task/session schema, immutable preparation, retry fingerprint or cleanup adapter changes.

### Legacy disposable review databases

The optional selected-resource renewal also supports the exact original
`spatial-neon-review` database receipt with an explicit database-only DROP
instruction. Its same-task development cutover is preserved provenance, never
another deletion target. All registered review consumers must already be
Released. Bounded global ownership checks reject another active claim on the
exact database or whole Neon branch, including task-runtime provider claims.
The unchanged original preparation/operation and resource identity remain the
only authority; no new preparation, proof or live receipt is manufactured.
The client separately verifies provider lifetime, consumers, durable retry and
physical absence before the ordinary metadata-preserving Released write.

Actual disposable Unix control coverage exercises the normal Drafted resource
dispatch and Neon HTTP adapter: late foreign ownership and owner pause refuse
before DELETE; lost provider response resumes with one exact DELETE and raw
original metadata events unchanged. The read-only original71 compatibility
preflight confirms current legacy shape only, not live retirement.

### Original private credential exports

The selected-key v1 authority route recognizes only the exact recorded `credentials-export-development` private export recipe and its original same-task environment/Compose association. It checks the source, deterministic private journal and external capture storage against source/tooling, retained archives, other tasks' resource paths and registered worktrees. This is a local scope witness for an already-accepted operation, not new preparation or physical absence proof. The client separately authenticates the original committed encrypted backup/key, verifies exact export bytes and stopped consumers, and preserves the source inode through native capture before writing Released with unchanged metadata.

The disposable Unix route/whole-finalizer regression covers a late foreign capture-path claim, an initially absent Compose journal, native capture, a lost applied registry acknowledgment, exact retained-source preservation and unchanged original preparation/operation events. No live original71 private-export action is claimed by these tests.

For the exact historical r2/r3 task-app group, selected cleanup renewal returns
`nativeApps: { version: 1, recordedBefore }`, where the timestamp is the original
preparation event. An optional `nativePids` request is a bounded unique set of
positive process IDs. It is valid only with that complete original resource
scope, must include its recorded roots/listener, and is echoed sorted as
`nativeApps.pids`. It only extends global ownership exclusions; the client must
independently prove every process lifetime and hold the kernel identity while
renewing immediately before an individual signal. The saved full set is reused
through partial-stop retries, even after members exit. No new preparation,
resource metadata link or cleanup operation is written.
### Original Clerk creation evidence

For the exact older development test-user recipe with no `createdByTask` flag, selected-key renewal may derive a creation witness from the original delegate's configured Acpx record. Initial derivation runs outside the SQL transaction with bounded, held local reads. The frozen Compose environment and private-export location must agree; exact known script bytes, private user result, successful paired create output and subsequent matching resource registration must all correspond. Text-only history, reused users, unrelated delegates, altered registration and ambiguous evidence refuse.

Inside the existing authority transaction, current preparation/operation, selected resource, global sharing checks and original delegate relation are rechecked before saving one redacted `cleanup-clerk-original-creation` fact. This fact is outside the finalizer owner-action set and changes neither original proof bytes nor resource metadata. The compact response binds its revision/digest to the original primary and operation. Cached renewals verify the same immutable fact and relationships without requiring retired local inputs to reappear. It grants no independent cleanup authority; the client still verifies the exact provider instance/user lifetime and current scope before deletion and fresh absence before acknowledgment.

The actual Unix fixture covers durable witness response loss, cached recovery after local evidence retirement, late foreign ownership and owner pause, provider response loss and registry acknowledgment loss, with one effect and unchanged original preparation/operation. Live original-task acceptance remains separate.

### Current development database backup scope

The same selected-key operation may recognize the exact original development `task_spatial` tuple when its recorded cutover, retained local Compose group and source identity agree. Other development compute and the review database must already be Released. The server protects deterministic private backup storage against every registered cleanup root, retained material, foreign resource claim and registered worktree. It performs no provider, Docker, dump or credential reads during this scope check. The wire and original preparation/operation remain unchanged.

The client retains a complete immutable custom archive before the existing database-only dispatch, independently verifies saved native process absence and stopped local consumers, and checks absence from the recorded surviving verification database. Remote Released state never removes local migration-source protection. The actual Unix whole-finalizer regression covers normal native/export ordering, late storage ownership, lost DELETE and Released replies, one provider effect, unchanged original events/resources and retained local data. This is disposable verification, not original-task execution.

### Original source in a version 1 operation

The existing bearer-authenticated task `legacy-evidence` route accepts a strict
`kind: "original-work"` adoption. It names the exact original preparation and
operation revisions and raw/canonical digests plus a private, manifest-covered
bundle archive. The independent restore must equal the accepted clean snapshot.
Ignored material requires explicit owner-selected paths and remains in the
whole-source capture; the existing installed-dependency identity rules apply.

One append-only `finalization-legacy-original-work` proof holds the file archive,
restore result, exact source inventory and linked Git administration capture.
It is outside the original owner-action epoch and neither registers a resource
nor rewrites the historical preparation, operation or evidence supplements.
Owner retries reuse the exact proof, including after both original paths are
captured. Trusted primary IPC still cannot adopt this owner authority.

Compact renewal rechecks the original operation, proof and global path claims.
Full boundaries recheck archive bytes, any retained common-Git prerequisites,
source/admin inventories and handle boundaries, and actual Git registration
absence. The shared capture engine preserves each original inode and retries
lost capture replies without calling Git removal or resetting source. The
retained Compose boundary separately observes external recipe/cutover files and
stopped Docker lifetimes after original source paths disappear.

Disposable owner-route/Unix tests cover the 56-record shape, raw-only operation
CAS drift, foreign path claims, exact clean snapshot and ignored-byte refusal,
private archive drift, native source/admin lost replies and path recreation.
Live archive/adoption/capture is separate from this source verification.
