# Cleanup uses persisted delivery authority

The prepared-v1 lifecycle binds the existing `finalize:<taskId>` preparation to
an immutable local cleanup operation. It does not replace the original
preparation, completion contract, verification, retirement grant, retained
evidence proof or tooling pin. A current Linear status is neither new cleanup
permission nor a revocation of an already accepted delivery.

`prepare-finalization` accepts `cleanup: true` for a genuine existing v1
preparation. Full preparation verifies the current original worktree/Git
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

The task-bound prepare/confirm routes resolve the primary directly. Drafted's
cleanup requests use these routes, avoiding a full task projection before every
native removal batch. Existing session routes and old receipt shapes remain
available. Registry updates cannot add targets, change frozen identities or
resurrect released resources; a paused task may still record a same-state stop
observation without granting deletion authority.

This first increment covers existing v1 preparations. The shared destroy CLI,
dependency-aware adapter scheduling, durable reporting independent of closure,
and external/older delivery correspondence are subsequent integration work.
It does not authorize an unprepared or merely Done task, and it does not alter
live resources or declare DRA-194 complete.

Validation includes real Git/SQLite fixtures and the actual Drafted control
client over a disposable Unix socket into the server routes. The latter binds a
retained 8 MiB archive and performs 128 renewals within a real 10-second deadline
with no task GETs, including database/client reconnection, pause rejection and
full-boundary rejection of changed retained bytes. Run with
`DRAFTED_INTEGRATION_ROOT` pointing at the matching Drafted checkout.
