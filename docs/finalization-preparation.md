# Long cleanup preparation

A full cleanup check can spend longer than a control request's deadline hashing
retained archives and the original worktree. New Drafted clients acknowledge
that check before waiting for its result. No cleanup effect is permitted by an
acknowledgment, progress row, or failed verification.

The existing prepare-finalization task/session route accepts an opt-in strict
`preparation` object with `version: 1`, a UUID `attemptId`, and a bounded `boundary`
name. It is valid only with `cleanup: true` and a full check. The finalization
request key, original preparation, cleanup operation, owner proof and tooling pin
stay unchanged. Authority-only renewals and confirmation retain their existing
protocol. Old synchronous callers receive a bounded busy error while the same
primary has a pending or executing preparation, including internal full calls.

Acceptance, request aliases, stage timings and terminal results are append-only
RuntimeMetadataEvent records. Scoped indexes enforce request identity. The
existing runtime projection tick drains one full preparation at a time while
continuing normal journal projection and HTTP service. The worker and older
synchronous requests share a reservation, so acknowledgment races cannot start
overlapping scans. The server's existing runtime ownership lock remains the
process ownership boundary; there is no second timer, agent or cleanup executor.

Retries of a lost acceptance or polling response reuse the same attempt. Another
request for the same boundary and exact ownership/turn epoch joins its pending
scan. A completed result belongs only to that attempt and logical boundary; each
new full client call creates a fresh attempt and re-observes physical content.
A new boundary cannot reuse a completed physical scan merely because database
identity is unchanged. Clients still perform their existing target checks before
effects, and full confirmation independently verifies cleanup.

Task/pin/resource identity, accepted owner history, pause/revocation and original
turn correlation are checked before execution, before the durable ready result,
and on result replay. Status edits alone are not revocations. A completed turn or
new original-primary turn cannot consume the preceding turn's observation.
Initial verification may establish its legitimate retained-archive proof before
binding the cleanup operation; that separate proof is not mistaken for a new
owner decision. No old prepared/proof bytes are rewritten.

A restart resumes a queued or interrupted read-only attempt under its original
identity. An unfinished scan must be re-observed after process death; no partial
fingerprint is promoted to ready. A completed result remains durable and is not
scanned again for the same attempt. Failed attempts remain failed, with their
stage and retry state visible; a later full attempt can retry after the cause is
resolved. Progress logs include source, delivery, fingerprint, retained-archive,
persistence and response timings when those stages execute, without file bytes
or credential-bearing provider messages.

Drafted polls only this idempotent protocol. Each HTTP call keeps its ordinary
finite deadline, reduced to the remaining overall ten-minute polling budget.
Late ready responses do not extend that budget. Exhaustion reports the exact
attempt/stage and preserves resources; the accepted server verification can
finish, and a later request joins any still-pending work. This does not turn
resource writes or arbitrary control requests into automatically retried effects.

This increment converts full cleanup preparation. Explicit archive-inspection
and confirmation endpoints remain synchronous. It does not authorize deployment,
mutate live tasks, or change the meaning of verification or retained resources.

## Verification

Disposable real Git worktrees, SQLite journals and Unix control sockets cover
lost acceptance, queued/restarted and killed-verifier recovery, original
preparation preservation, same-boundary joins, next-boundary changed worktree and
archive rejection, paused/revoked/re-pinned/terminal-turn rejection, and a
synchronous/accepted scan race. The paired Drafted client waits through two real
16-second fingerprint stages while one-second HTTP requests and normal projection
ticks continue. Actual explicit destroy and serialized automatic cleanup fixtures
still confirm, close through the control routes, and retry frozen reporting.
