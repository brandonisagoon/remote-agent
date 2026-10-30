# Cleanup uses persisted delivery authority

The prepared-v1 lifecycle binds the existing `finalize:<taskId>` preparation to
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

These increments cover existing preparations and first-time preparation from
existing accepted v1 delivery authority. The shared destroy CLI,
dependency-aware adapter scheduling and external/older delivery correspondence
are subsequent integration work.
It does not treat a merely Done task as accepted delivery authority, and it does not alter
live resources or declare DRA-194 complete.

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
External/v2 continuation remains the companion legacy-delivery change. No live
teardown was performed.

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
