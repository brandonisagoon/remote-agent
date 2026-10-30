# Track work and PRs separately

The work graph can describe which useful issues share a delivery and who still needs the task environment. Ordinary implementation steps remain checklist items in the source plan. The existing primary owns this metadata; recording it does not create another task/session, approve a merge, provision resources or run cleanup.

`read_work_graph` retains its direct-child graph and adds `mapping` (null for an unclassified legacy task) and `unmappedIssueIds`. The additive `record_work_map` session tool calls `PUT /api/sessions/:sessionId/work-graph` with:

- `version: 1`, an immutable `requestKey`, and `expectedRevision` from the current mapping (0 for the first).
- `units`: exact source/direct-child issue IDs, `kind` (`outcome`, `deliverable`, `work-item`), acceptance description and delivery IDs. The source must be included. Several work items reference the same delivery.
- `deliveries`: unique ID, scope, boundary (`pr`, `review`, `merge`, `deployed`), and `dependsOn`. Optional `proposed` records repository, branch and base branch; optional `pullRequest` records repository, number and exact head. These are references, not proof. `stackedOn` requires an explicit same-repository base/dependency. Duplicate PR identities, missing dependencies, cycles and conflicting stack bases refuse.
- `remainingConsumers`: exact source/direct-child IDs and the reason they still need the shared environment. Only actual current use belongs here; statuses and child counts never imply use.

The existing metadata journal stores each mapping with the original task/primary/worktree/pin/source identity. Writes recheck membership and use a transactional revision compare-and-swap. An identical request replays its original snapshot without replacing a newer revision. Changed payloads under the same key, pause, changed primary/pin, ended source ownership or stale revisions refuse. No historic preparation, approval, delivery or cleanup receipt is rewritten.

The graph joins references to existing completion observations and accepted external-delivery bindings. It does not run a second GitHub observer. Every fact includes its observation source/revision/time. Proposed/unmatched PRs stay unobserved; a failed verification, replaced contract, changed exact head/base or revoked accepted binding cannot satisfy mapped shipping. An accepted merge does not establish review approval or deployment. `deployed` remains unobserved because these receipts do not prove deployment. This projection carries `authority: "none"`; it cannot authorize effects or replace existing completion checks.

Work items can finish against their own evidence while a shared PR remains open. Mapped deliverables/outcomes also require their observed delivery boundaries and dependencies before completed issue updates. Existing unmapped child behavior remains unchanged. Provider graph changes remain visible as stale/unmapped issue IDs rather than inferred mappings.

An explicit remaining consumer prevents existing v1/v2 preparation and effect-authority renewal until the primary reconciles current use in a new mapping revision. Completing a child does not clear the hold. Clearing it supplies no cleanup approval: every existing owner, identity, process, retention and physical-effect guard still applies. Absence of a map adds no prerequisite to legacy cleanup, including current Done cleanup. No future Cleanup status, migration, new label group, scheduler or second executor is required.

DRA193 already supplies accepted multi-PR completion. A three-PR outcome uses those actual accepted deliveries and its separate cleanup snapshot, rather than inventing one PR on the original task branch. Work maps do not expand the legacy single-PR Merge authorization or cause rejected scope to merge.

## Validation

Disposable SQLite/route tests cover shared work items, stable request replay, preserved revisions, pause/pin/reparenting refusal, explicit holds, cycles/stack conflicts, observed versus proposed progress and untouched task/session/resource state. The actual child-publication path completes two work items without finishing their unobserved shared delivery or removing the environment. An existing real-Git external-delivery fixture adopts three exact PRs, shows partial then complete mapped progress, refuses a late consumer hold, and confirms/retries cleanup with unchanged accepted binding/preparation. Provider observations in these tests are fixtures; no live task or PR is modified.
