# DRA-33 release gate

## Current coordinated cutover — November 6

The owner authorized completion through verified deployment on November 6. The
existing DRA-21 executor (`cmw46mdjx0000s8xcrouvmoum`, `drafted-tooling`) alone
owns shared process changes and the single coordinated server/tooling cutover.
The source primary continues implementation, isolated acceptance and review;
the execution reservation is not a hold on that work. Historical issue states
and an unlaunched child issue do not block reviewed artifact integration.
DRA-23 retains its separate source ownership.

The dated sections below describe the October rollout. Their wait-for-issue-Done,
unchanged-server and no-schema-change assumptions do **not** authorize or govern
this new server deployment. Do not use the superseded DRA-6 recovery kit or the
old tooling-only paired-release operator.

The release handoff must distinguish **source-ready**, **verified** and
**deployed**. Record exact commits and trees, PR merge status, hosted gate URLs,
independent reviews, isolated acceptance receipts and exclusions. A healthy
process or a green source gate alone is not deployed workflow acceptance.

### Required execution evidence

1. Freeze the reviewed server and tooling objects. Run repository gates for the
   actual changes and retain earlier scoped acceptance honestly. Preserve old
   task pins, owner pauses, original primaries, queued instructions and resources.
2. Reconcile the candidate migration inventory with the applied ledger without
   rewriting history. The candidate includes the exact already-applied
   `20261105203000_metadata_polling_indexes` SQL, SHA-256
   `08bac435f8a88df49d790230a7e6624adb767319ea20090b6b17b6dc70c6519b`.
   The pending `20261105200000_tooling_release` migration sorts earlier;
   `test/dra33-migration-order.rehearsal.ts` verifies actual Prisma deployment
   after the later index migration, unchanged prior ledger rows and replay.
   This disposable proof does not replace the executor's actual database,
   process and recovery rehearsal.
   The tooling migration now wraps its additive DDL in an explicit transaction,
   SHA-256 `526b16c7beed684686b83df0cd9179a50bbd3aaba03f160849de72d2fe673a0b`.
   Before applying it, prove this migration is still pending in the target ledger.
   Preserve any existing applied checksum; do not rewrite it to match this file.
   A crash before DDL commit must leave no tooling objects; a crash after commit
   but before ledger completion must leave the exact complete schema and empty
   tooling tables. Any recovery through Prisma resolve requires the executor's
   reviewed classification, stopped-holder proof and unchanged prior ledger.
   The WAL-mode order/replay test is not a crash-recovery or live-cutover proof.
3. Require a reviewed, bounded, no-cancel bootstrap drain before stopping the
   shared daemon. Deployed `6f972` has no supported global hold. Tooling callback
   admission is not a global drain; owner pause, shutdown cancellation and
   quiet polling are not substitutes. The executor must prove ingress and
   worker coverage, preservation of queued work, and recovery after interruption.
4. Retain the complete old reader closure: code, generated Prisma client,
   dependencies, installed tooling and frozen receipts. Symlinked dependencies
   must not be mutated by preparing the new release. After tooling activation,
   a pre-protocol server is not an accepted rollback reader. Do not rewind a
   database after newly admitted effects; use a compatible reader or reviewed
   forward recovery.
5. Inventory legacy consumers and exact capability receipts before first
   selection. Ambiguous or unavailable receipts block that activation. Keep
   runtime v1 for v1-only readers; explicit runtime v2 migration is separate.
   Retire old roots only when unfinished operations, retained consumers, legacy
   readers, task pins and rollback requirements no longer reference them.
6. The sole executor records the actual cutover and post-cutover health and
   workflow receipts. Stop on a failing gate; do not independently restart a
   shared service or launch product work merely to manufacture acceptance.

The coordinating source primary maintains the concrete handoff at
`/private/tmp/dra33-cutover-readiness-20261106.json`, including pending external
execution requirements and delivery receipts. That private file is a release
artifact, not a portable path for another installation.

## Historical October rollout

The following records remain evidence of that earlier rollout only.

## Scope

| Work | Issues | Local implementation |
| --- | --- | --- |
| Durable owner and worker continuation | DRA-47, 55, 56, 64, 65, 66 | Inbox fairness, source/child routing, result isolation, exact-process recovery, bounded control requests |
| Child acceptance and truthful status | DRA-34, 57, 58, 60, 75 | Direct-child graph/updates, dependency gates, activity observations, bounded deduplicated comments, matching reaction acknowledgement, owner completion receipts |
| Existing authority and old pins | DRA-46, 48, 50, 52, 53, 61, 69 | Pinned policy, named committed capabilities, original-primary ownership, scoped preview denial handling, credential recovery discovery |
| Verification and communication | DRA-74, 76, 58 | Feature-scoped preview checks, no unrequested verification UI, concise writing and issue-writing skills, bounded parallel work units |

Previously resolved DRA-51, 54, 62, 63 and 68 retain their existing evidence. Their Done state must not be inferred for other children.

## Deployment hold

Owner instruction: finish this implementation, wait for the current product issues to clear, then deploy and use ready Todo/Backlog issues as real acceptance work. Never resume an owner-stopped session or repin a running task to satisfy this gate.

The gate cleared on October 28: DRA-14, DRA-23, DRA-28, DRA-36 and DRA-37 reached Done; DRA-35 was Canceled. Their tasks were closed and paused, with no executing/provisioning session or held browser control. Re-read Linear and task activity immediately before any subsequent activation; this historical observation is not a standing assertion that the gate is clear.

## Initial deployment and acceptance review

At 2026-10-28 07:01 UTC, the custom Air pilot activated runtime `53aeb03943f1fe0391a57a44275131b1598ecb6b` and configured new-task tooling `137bcf034860e086b7aa775ab00a2178db44bed7`. The installed desktop/default CLI were not replaced. Runtime/type/build verification passed (532 runtime tests, 48 tooling tests; 43 focused tests after integrating upstream teardown corrections).

The private receipt is `drafted-pilot/maintenance/dra33-release.5CTVJx/deployment.json` under the user's Application Support directory. It records preservation of all 23 task identities, 55 session/provider identities, original task pins and four stopped instructions. Config, manifest and consistent SQLite backups are retained beside it. The custom pilot uses an immutable runtime checkout and its existing launchd label; the standard install is separate and must not be changed accidentally.

The first bootstrap attempt encountered asynchronous launchd job removal. Rollback restored the old service; waiting for confirmed removal before bootstrap activated the new revision successfully. `management/supervisor/launchd-control.test.ts` now reproduces the ordering requirement, bounded wait and non-absence error handling without operating any real service.

Acceptance review closed DRA-53, DRA-55, DRA-58 and DRA-75 with issue-specific tests and the deployed receipt. It identified follow-up work before the first backlog launch: bounded failed-projection retries (DRA-47), meaningful stall publication (DRA-57), combined child/restart fixtures (DRA-34/65), and restoration of previously deployed Drafted guidance/safety checks omitted by the first package. Do not count an initial healthy process as proof of all these behaviors. New product work remains unlaunched until the corrected release is verified and activated.

## Release procedure

1. Freeze and verify both release trees: Remote Agent `bunx tsc --noEmit && bun test && bun run desktop:build`; Drafted `bun run check && bun test`. Validate generated writing/orchestrating skills. Review the actual staged diff; exclude dependency symlinks, private keys, plaintext environments, unrelated source changes and test artifacts.
2. Record separate source commits and integration PRs. Do not overwrite another chat's dirty checkout. Preserve contributor provenance when integrating already-written Drafted fixes. Publication is not installation.
3. Recheck the product gate, process-local task activity, pending instructions and uncertain deliveries. A paused task is not Done. If any current issue remains unfinished, wait. If effects or writers are uncertain, resolve through the supported owner path without restarting or replaying them blindly.
4. At the authorized idle gate, use the supported deployment/update path with its database/config snapshot and rollback. Record the installed server/CLI/desktop revision and health checks. Do not kill the owner's running development app.
5. Configure the committed Drafted capability revision for new work through the existing supported configuration path. Preserve old task pins; record separate host capability revisions when used. No schema migration is introduced by this batch.
6. Select one ready Todo/Backlog product issue with clear acceptance and satisfied dependencies. Launch through the existing owner-authorized workflow, inspect its actual acceptance receipt, and confirm one primary. Use independent child work/parallel delegates only where file and resource ownership permits. Do not launch all backlog issues at once or fabricate test-only work.
7. Verify owner-comment continuation, worker-result continuation, correct reaction, child updates/dependency gates, browser policy, meaningful concise checkpoints, activity status and end-to-end delivery on the actual work. Exercise old-pin capabilities only on an authorized applicable recovery, not by forcing a production failure.
8. Publish issue-specific evidence with task/session/provider/host and source/installed/tooling revisions. Mark a child Done only when its acceptance is satisfied; keep implementation-only and deployment-only results distinct. Preserve the rollback receipt and stop further rollout on a real regression.

## Periodic check prompt

Every five minutes, read current Linear/product task state and the recorded release gate without disturbing sessions. While unchanged or non-actionable, stay quiet. Notify only a meaningful state change, completion, failure, or required owner decision. Once the gate is clear and both source releases are verified, deploy through the supported path and run the bounded ready-backlog acceptance above. Honor later owner pauses and scope corrections. Never mark the gate clear solely because sessions are idle, paused or stale-active. Stop the monitor after release acceptance, or report the exact external blocker if action needs authority not already granted.

This prompt is a runbook, not proof that an app automation was created. Record the actual automation ID separately if scheduling succeeds.

## First real acceptance candidate

DRA-72 (clear front-edge selection completion) is a bounded Backlog candidate with no blocking relations at inspection time. It should build on the DRA-23 input contract only after the integrated product PR reaches staging. Exercise the existing front-edge flow, immediate feedback, necessary confirmation, keyboard/pointer behavior and saved-state reopening; do not create a demo page. DRA-71 (canonical property identity) is a higher-priority but broader follow-on that also exercises address/provider recovery. Re-read both issues and dependencies before dispatch; this note does not launch either.
