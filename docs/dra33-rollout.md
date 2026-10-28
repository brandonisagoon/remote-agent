# DRA-33 release gate

This implementation is local until the release and live acceptance receipts below exist. Passing automated tests is not deployment or completion of the umbrella issue.

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

The latest read-only checkpoint found DRA-14, DRA-23, DRA-36 and DRA-37 Done, DRA-35 Canceled, and DRA-28 still in Verification. DRA-28's product integration PR is #4227 against staging; its issue says required CI is running. Re-read Linear and task activity immediately before deployment. These historical observations are not a standing assertion that the gate is clear.

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
