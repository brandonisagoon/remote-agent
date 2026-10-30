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
