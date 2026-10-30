# Retire an already-Done task

An issue's Done state does not authorize cleanup. An authenticated owner can separately authorize retirement of one exact delivered task through `PUT /api/tasks/:taskId/completion/retirement`. The original primary, worktree, tooling pin and finalization request remain unchanged. This path is limited to an open primary whose task is complete and unpaused; closed-primary maintenance is separate.

Both inspection and authorization require the owner's bearer credential, including over the local control socket. Session tools and ordinary resource receipts cannot create this authority. The operation records no passing check, release, Git mutation or Linear state change.

## Authorize

First reconcile the task's ownership receipts and retain required archives. The task must already have a current merge completion contract and an accepted verification receipt for its current content. Missing verification must be resolved from actual checks through the existing owner verification API. Retirement does not replace verification or archive proof.

Use the supported cleanup capability's `resource reconcile --task <id> --socket <socket> --key <receipt-key>` for active public previews and legacy launch receipts. Public-preview reconciliation reads the provider and records exact hostname, tunnel, zone, DNS and account identities, or exact quick-tunnel connector keys. It does not delete DNS, edit ingress or stop connectors. A recorded null DNS ID permits an already-absent record, never discovery of a new deletion target after authorization. Legacy launch reconciliation must finish expanding exact manifest hashes and member receipts before authorization.

`GET /api/tasks/:taskId/completion/retirement` always returns the current authority revision and action. An eligible task additionally returns its source state, exact binding digest, contract and verification revisions, and resource identities with metadata digests. An ineligible task returns a binding error and no usable digest, so the owner can still recover a lost revision and revoke. It does not expose metadata values. Read it immediately before authorization, then send:

```json
{
  "action": "authorize",
  "requestKey": "owner-retirement:<task-id>:1",
  "expectedRevision": 0,
  "expectedBindingDigest": "<bindingDigest from inspection>",
  "basis": "Retire this task's accepted delivery and preserve its retained archives.",
  "delivery": {
    "repository": "owner/repository",
    "pullRequest": 123,
    "head": "<exact accepted PR head>",
    "mergeCommit": "<exact merged commit>",
    "baseBranch": "staging"
  }
}
```

The server independently observes the PR, accepted head, branch, base, merge and required review, then verifies that the merge is an ancestor of the provider's current base. The submitted delivery must also match the existing merge contract and accepted verification. Dirty or changed work refuses authorization. Task identity, source issue, original primary, tooling paths and revision, completion/verification receipts, and the complete resource set are frozen together. Lifecycle states and `observed`/`observedAt` annotations may change. Preview cleanup may add only fixed terminal observations and clear its public URL with a strict completion record matching the frozen hostname, tunnel and shared/quick-connector scope; related provider or connector receipts must already be released. Resource identities, other metadata, leases, additions and resurrection of already-released receipts invalidate the binding.

## Finalize and retry

Use the supported cleanup capability from the original primary. A compatible Drafted finalizer recognizes the strict additive `retirement` receipt, refreshes server authority during resource cleanup, and publishes the server's immutable Done-to-Done handoff after confirmation. Existing clients reject the extra receipt fields rather than silently using legacy cleanup. Do not repin or replace the task to use this capability.

Each prepare and confirm rechecks current Done source authority, exact binding and provider merge ancestry. Existing ownership, clean-worktree, released-resource and Git absence checks still apply. Unarchived evidence, unsupported resources and unknown ownership remain blockers; this endpoint does not mark them released. In particular, this change does not add release adapters for native apps, dependency installations, retained evidence archives or arbitrary filesystem directories. The same `finalize:<task-id>` receipt survives an interrupted removal, publication or close response. Cleanup never requires a backwards Done-to-Merge transition or another merge.

## Revoke

Send the latest authority revision with a new stable request key:

```json
{
  "action": "revoke",
  "requestKey": "owner-retirement:<task-id>:revoke-1",
  "expectedRevision": 456,
  "basis": "Stop further retirement work."
}
```

Revocation is allowed even if the task subsequently pauses or its identity changes. A stale write or replay of an earlier grant cannot override it. A prepared finalization fixes its authority and cannot be expanded or rebound by creating another grant. Preserve interrupted resources and reconcile the prepared receipt after revocation.

## Validation

`retirement-authority.test.ts` covers Done without authority, bearer-only access, exact successful delivery, stale and revoked grants, changed task/pin/resource/verification bindings, dirty work, unavailable ancestry, observation races, and replay after removal. Set `DRAFTED_INTEGRATION_ROOT` to the matching Drafted checkout to run the actual client and server together against disposable Git worktrees and a fake preview provider. The tests confirm one durable preparation and confirmation, one comment, zero Linear state writes, close after a lost publication response, named/quick preview cleanup, DNS deletion response loss, and changed-ID refusal before deletion.
