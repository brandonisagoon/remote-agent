# RA-23 pre-deployment evidence

This is an initial source batch, not closure of RA-23 or its children. It changes
no deployed server, active tooling selection, live config, task or provider.
Drafted's paired adapter now requires operation protocol 3; this server supports
1–3 and retains existing 1/2 bindings. State formats and task pins are unchanged.

| Issue | Implemented in this batch | Still required before closure |
| --- | --- | --- |
| RA-20 | Existing launch-ordering work remains in server PR #112 and Drafted PR #113. | Integrate and validate those separate changes; deployed acceptance. |
| RA-21 | Keep completed fresh baseline proof while its replacement is collected; revoke on completed failure with refresh-token fencing. Fenced errored delegates with no actual activity no longer reserve absent compute solely because of their error status. | Historical observer adoption, reclamation refresh stability, completed cleanup proof/slot reconciliation, safe app-only stop while finalization is pending, combined claim/collector stress coverage. The three-app cap is unchanged. |
| RA-22 | A guarded configure attempt can observe its own pending generation using its bound release. Ordinary collectors still refuse unconfirmed producers. Recheck attempt/parent/offer ownership at commit; ignore telemetry-only changes. New configure identities exclude the independently checked lock PID; exact legacy digest replays still work. Drafted preserves the accepted resource projection across restart before acknowledgment. | Legacy full-body binding recovery with a changed PID; resolved-before-confirm retained-reader reconciliation; ended configure-child reconciliation; bounded diagnostics and web-memory policy; automatic original-task continuation and full paired route/adapter replay. |
| RA-24 | Drafted makes localized implementation and supported recovery primary-owned; useful delegation and independent review remain available. | Composed skill tests plus a real small task with no mandatory setup/implementation delegate. |
| RA-25 | Completed turns stop generating source comments in direct-source and mirror projection. Explicit replies and failed-turn delivery remain. Suppressed output remains journaled. | Typed durable progress identities, blocker episodes and recurrence, shared explicit/fallback receipt reservation, legacy pending-delivery migration, stall integration. This is not full task-level deduplication. |
| RA-26 | Focused regression fixtures cover the changes above and the paired API-origin restart repair. | One combined route/adapter test across launch, recovery, capacity and handoff; then a deployed task with zero avoidable owner nudges. |
| RA-27 | Drafted guidance carries standing synthetic-account authorization and distinguishes login access from scenario suitability. | Durable quota-bounded account allocation, exclusive task assignments and retry/concurrency recovery; actual Clerk age verification and browser switching. The existing identity command remains read-only. |
| RA-28 | Drafted packages the exact November 5 seven-case source, a version/digest index, exclusions and provider-composed guidance for preparation, orchestration, verification and review. | Existing-task capability continuation and execution of selected cases on a deployed task. Missing source images remain explicit gaps. |
| RA-29 | Read-only inspection of the serving host confirms the selected Greenfield policy contains Merge. Actual DRA-46 and DRA-52 webhook receipts delivered to their existing primaries. DRA-52 has a verified merge and confirmed finalization. | Check other repositories' intended policies and preserve retry/revocation coverage. DRA-46's configuration-only delivery is blocked later by the completion contract requiring a PR; adding another Merge workflow would not fix that separate gap. |
| RA-30 | Drafted derives consistent Platform API URLs, preserves admitted old recipes, and supports a narrowly scoped missing-server-origin repair with lost-acknowledgment recovery. | Paired server/adapter configuration replay and real catalog, proxy and server-rendered pricing checks on the serving host. |
| RA-31 | Drafted's existing evidence reader accepts `sizeBytes` as an alias, rejects conflicting sizes and preserves the original metadata. | Shared registration/cleanup schema, complete server-side alias parity, historical task-directory validation, exact connector lifecycle adapter and provider-deletion retry tests. |

## Regression evidence

The focused server suites are `compute-baseline.test.ts`,
`compute-configuration.test.ts`, `tooling-operations.test.ts`, the runtime-event
projection suites and `source-messages.test.ts`. They exercise held refreshes,
expiry/failure, errored queued delegates, exact configure scope, restart/lock PID
replay, concurrent telemetry, silent completed turns, failure publication and
owner replies. Protocol activation tests retain historical readers and refuse
unsupported releases.

Drafted's corresponding runtime/API-origin, tooling-operation, evidence and
composition tests use temporary worktrees, a real local control transport and
synthetic provider/container responses. They do not prove Docker, Clerk, nginx,
Cloudflare, live pricing or browser behavior on the remote execution host.

Server source `22e1de0` passed local typecheck, 3,138 tests (154 skipped,
zero failures), and desktop build. GitHub CI independently passed lint,
3,140 tests (154 skipped, zero failures), and desktop build at the same commit.
The platform-dependent test totals are recorded separately. The later changes
to this file only update evidence.

The subsequent CI run at documentation commit `75f6bb5` recorded 3,139 passes,
154 skips and one five-second timeout in the adoption-lifetime test that bundled
three database scenarios. Its isolated replay passed all 24 tests. Those three
independent scenarios now have separate tests using the existing setup/cleanup,
assertions and unchanged timeout. The revised suite passed 26 tests and 794
assertions, and typecheck passed. Full CI for this test-only correction is pending;
the earlier green run is not represented as the latest head's result.

Drafted's complete sweep recorded 2,462 passes, 37 skips and two failures:
an evaluation-document contract and a stale protocol-version expectation.
Both were corrected; the affected four-suite replay passed 38 tests with zero
failures, and final-head typecheck passed. This is not claimed as a clean full
suite at the final Drafted head. Full paired integration remains outstanding.

## Read-only Merge diagnosis

The live server's authenticated tooling-selection read and SQLite receipts
identify Greenfield generation 3 at Drafted `52c67d3`. Its policy blob
`2b04bd7d1386e4966c2f2ba4a500bf76db6e7556` matches the saved boot pin and
routes exact Merge state changes through the existing primary with Codex.
The repository's target is staging. No live setting or transition was changed.

DRA-52 receipt `cmw9x2j0d00q229xcovm9k50m` and DRA-46 receipt
`cmwa1kimd017q29xc9xi7rlww` both have delivered merge workers and completed
instructions. DRA-52 separately has a merge observation for Greenfield PR 4418,
confirmed finalization and a closed task; Linear is Done. Its cleanup needed
audited maintenance recovery, so this is not zero-intervention acceptance.
DRA-46 remains waiting with its app stopped: accepted configuration-only work
cannot pass the current PR-required finalization boundary. A completed inbox
instruction alone proves neither merge nor cleanup.

## Deployment boundary

The owner's November 9 direction is one coordinated cutover after the remaining
pre-deployment work across RA-23. Child issues and PRs are implementation/review
units, not separate deployments. Integrate the RA-20 changes with this batch and
subsequent reviewed source before freezing the exact server/tooling revisions.
Require clean final repository gates, combined acceptance, an isolated upgrade,
restart and interrupted-operation rehearsal, and a verified rollback procedure
from the serving versions. Resolve any required intermediate live rollout before
calling the pair ready.

Prepare one release manifest with compatible server installation followed by
dependent tooling activation in the same cutover. Original affected-task checks
and the RA-26 zero-avoidable-nudge run follow that cutover.

Complete the remaining source work and paired integration coverage before
calling the whole epic source-ready. Preserve the original task pins, accepted
operation IDs, resource/data identities and three-app cap. Installation,
activation, server restart, live configuration changes, provider mutations and
existing-task continuation are a separate controlled rollout. No issue is Done
based only on these source tests.

## November 10 cleanup and deployment-reader checkpoint

RA-31 now has matching registration/cleanup evidence readers for `bytes`,
`byteSize`, `size` and `sizeBytes`, including standalone, contained and retained
files. New incomplete or conflicting file receipts fail before registration.
Historical fields and original accepted cleanup requests remain unchanged.
Dedicated connector receipts have a versioned complete process identity and a
matching observer contract; unresolved duplicate PID claims on the same host
block registration and cleanup renewal. Drafted owns the identity-bound signal
and connection-checked provider deletion within the existing finalizer.

The paired server/tooling fixture passed 167 tests with 701 assertions. It
includes a seven-file DRA-52-shaped historical directory using `sizeBytes`, the
actual control socket and retained-evidence adapter, replay, original binding
preservation, and unchanged archive copies. Tooling's focused 11-suite run
passed 165 tests with 987 assertions. Both repositories typecheck. Connector
and Cloudflare effects remain synthetic in this batch. Combined original-task
connector/finalizer acceptance, clean final full gates and deployed acceptance
are still required; RA-31 remains Implementing.

CI at `45670ab` failed a different deployment snapshot case: 3,141 passes,
154 skips and one failure. Native database handles from the compatibility read
could remain open after close, making the following WAL snapshot correctly
refuse quiescence. A separate-process regression reproduced that failure without
forced GC or sleeps, even after replacing the detached read transaction. The
management read now runs in an awaited read-only Bun child, ending every handle
before snapshotting. All 14 deployment/rollback tests now pass, with 72 assertions,
including real-holder refusal and committed-WAL restoration. The snapshot guard
was not weakened, and no live deployment ran. Full CI subsequently passed at
`1f82fbe` (run 42851450857). The later capacity source needs its own final gates.


## November 10 capacity and historical-observer checkpoint

RA-21 now keeps fresh completed reclamation proof during a replacement read,
shares concurrent collectors, and lets a blocked claim join a pending collection
outside SQL for up to ten seconds. Expiry and final identity/budget checks remain
mandatory. Failed or running reads revoke only their original generation.
Accepted cleanup can relinquish a removed app's exact allocation while its
original primary continues unrelated cleanup; a fresh independent absence check,
current accepted cleanup authority, restart fence and settled other writers are
required. Starts and renewals honor that same fence.

Owner-only historical observer inspection/adoption supports both baseline groups
and original environments. Available original executables are preferred. When
unavailable, a registered immutable compatible reader must independently prove
all original physical members stopped or absent before its choice is recorded.
Adoption changes only one audited reader selection, never task pins, producer
provenance, pause, resource/configuration state or capacity. Normal collection
must read again before granting credit. The reader and retained owner/member
identity remain bound, and incompatible, changed, active, unknown or shared
inputs refuse. Finite baseline diagnostics distinguish missing original readers
from changed adoptions.

Validation: 220 focused tests passed with 1,238 assertions and typecheck passed.
The separate accepted-cleanup/refresh batch passed 217 tests with 850 assertions.
The actual paired Drafted adapter at `b6b8d81`, immutable installation receipts,
SQLite and disposable Docker containers passed two integration scenarios with
34 assertions: ordinary original-reader collection and explicit historical-reader
adoption; extra-member refusal; actual restarted-container claim refusal; and
claim of the same waiting reservation after physical shutdown. Original task,
resource, pause and pin records remain preserved. Every created container was
removed by its recorded exact ID after verifying its task label.

That integration fixture uses real containers and the real accounting adapter;
it is not actual Greenfield application health or deployed workflow acceptance.
App-only stop before final verification, combined interruption/restart and
original-consumer zero-nudge acceptance remain open. New observation contracts
require this server before dependent Drafted activation in the coordinated cutover.

### Merged app stop without a verification waiver — November 10

RA-21 now uses the existing automatic stop intent and original producer adapter
after the server observes the owner's exact merged source and no app consumer
remains. Stale final verification still refuses completion. Fresh full coverage,
settled original descendants, unchanged source, owner authority and retained
review/browser checks remain required. Data and cleanup evidence stay retained.
The collector records a real running lifetime before stopping it, including a
newly claimed app that merged before its first collection tick. Stopped capacity
reconciliation now includes descendants that moved working directories.

Validation: 117 focused tests passed with 514 assertions. The actual paired
Drafted client at `add1ac4`, Unix routes and isolated SQLite passed five lifecycle
scenarios with 135 assertions. The merged-source scenario preserves stale
verification through lost completion response, database reconnect and duplicate
continuation; the app stops once and its original slot settles. Ordinary
stop/resume, pause during inspection and busy setup also pass. These lifecycle
fixtures use synthetic Docker/provider and physical-observer responses; the
separate real-Docker accounting proof above remains distinct. Typecheck passed.

Closed-family recovery after interruption and the combined original-consumer
release rehearsal remain open. No deployment or live task mutation occurred.
