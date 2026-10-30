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
