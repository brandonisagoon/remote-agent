# Long cleanup preparation and confirmation

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

Nested stages restore their parent after completion. End events now carry an
explicit `outcome` (`succeeded` or `failed`); a propagated failure records the
deepest failed stage, so a successful fingerprint cannot be blamed for a later
delivery error. Existing end events remain readable; absence of an outcome in
historical rows is not proof of success.

Failed rows include a bounded `diagnostic` code and reason. The same code/reason
appears in the existing progress `error` string, preserving released clients'
strict response schema. Only reviewed fixed classifications are saved, including
missing PR versus other PR lookup failures, known worktree/archive/authority
guards, and selected filesystem/network codes. Arbitrary exception messages,
names, stacks, causes, command output, paths, private URLs and payloads are not
copied. Unknown failures explicitly report `UNCLASSIFIED_FAILURE`; they are not
silently reclassified as fingerprint drift. These diagnostics add no cleanup
authority, automatic retry or repair, and cannot reconstruct an earlier lost
exception. In particular, DRA-42's unchanged existing retry succeeded after its
initial failure; no persistent fingerprint defect is established by that history.

An unidentified filesystem handle now retains `FILESYSTEM_UNVERIFIED` with its
numeric process ID, bounded descriptor, allowlisted type and fixed missing-type,
unknown-type, missing-name or nonabsolute-path classification. Unlisted types
and descriptors become `other`; the observed name itself is never retained.
The durable worker row keeps these validated fields and the existing client
error string includes the same safe details. Malformed typed details produce the
fixed unverified reason, not raw exception output. This does not change the
handle refusal predicate or its existing narrow retry rule. It identifies a
future refused observation; it cannot recover the omitted handle from original
DRA-98 attempt 1808 or establish the cause of an earlier attempt.

Drafted polls only this idempotent protocol. Each HTTP call keeps its ordinary
finite deadline, reduced to the remaining overall ten-minute polling budget.
Late ready responses do not extend that budget. Exhaustion reports the exact
attempt/stage and preserves resources; the accepted server verification can
finish, and a later request joins any still-pending work. This does not turn
resource writes or arbitrary control requests into automatically retried effects.

This increment converts full cleanup preparation. Explicit archive-inspection
endpoints remain synchronous. It does not authorize deployment,
mutate live tasks, or change the meaning of verification or retained resources.

Cleanup confirmation uses the same journal, worker, serialization reservation and
bounded polling protocol. `confirm-finalization` accepts `confirmation` with the
same version/attempt shape and the literal boundary `confirmation`; it requires
the existing bound cleanup operation. The response uses a `confirmation`
envelope. Accepted rows distinguish confirmation from preparation without
rewriting old rows. A token cannot cross phases. Old synchronous confirmation
remains supported, but cannot overlap a pending or running full boundary.

The worker calls the existing full confirmation implementation, including
physical absence, retained bytes, resource proofs and authority checks. It only
returns ready after the durable confirmation belongs to the exact original
preparation and operation. Lost HTTP responses join the same attempt; ready
replays renew local authority and match the saved confirmation revision. A crash
before journal completion repeats read-only verification and reconciles the
existing confirmation/report rather than creating a replacement operation.
Each new confirmation attempt rechecks physical content; cached ready progress
is scoped to its accepted attempt and ownership/turn epoch.

The ordinary Drafted lifecycle now polls confirmation under the same finite
ten-minute total budget and ordinary per-request limit used for preparation.
Pending, failed, mismatched or late responses never permit closure. A resumed
finalizer whose initial full preparation already carries a confirmed revision
skips resource and worktree retirement, obtains that exact current confirmation,
then performs only the existing close/report steps. There is no custom wrapper,
manual close, extended-deadline requirement, new approval or second executor.

## Verification

Disposable real Git worktrees, SQLite journals and Unix control sockets cover
lost acceptance, queued/restarted and killed-verifier recovery, original
preparation preservation, same-boundary joins, next-boundary changed worktree and
archive rejection, paused/revoked/re-pinned/terminal-turn rejection, and a
synchronous/accepted scan race. The paired Drafted client waits through two real
16-second fingerprint stages while one-second HTTP requests and normal projection
ticks continue. Actual explicit destroy and serialized automatic cleanup fixtures
still confirm, close through the control routes, and retry frozen reporting.
