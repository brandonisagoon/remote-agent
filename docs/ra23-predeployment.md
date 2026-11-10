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
| RA-29 | Confirmed the committed Drafted policy already routes Merge to the existing session and the merge skill rechecks current authority. | Inspect the serving host's boot-resolved policy, then add missing configuration or fix routing based on that evidence; exercise webhook retries and revoked approval. The local saved SSH alias did not resolve during this pass. |
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

## Deployment boundary

Complete the remaining source work and paired integration coverage before
calling the whole epic source-ready. Preserve the original task pins, accepted
operation IDs, resource/data identities and three-app cap. Installation,
activation, server restart, live configuration changes, provider mutations and
existing-task continuation are a separate controlled rollout. No issue is Done
based only on these source tests.
