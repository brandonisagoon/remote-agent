# Finalizing an accepted delivery from another repository

An external delivery binding lets a task finish work delivered through specific
PRs in other repositories while retaining its original task, primary session,
product worktree, base commit and tooling pin. It supplements the existing owner
Merge approval; it does not rewrite that approval or claim the product worktree
revision was merged.

The bearer-authenticated supervisor API provides:

- `GET /api/tasks/:taskId/completion/external-deliveries`: current binding and revision.
- `PUT /api/tasks/:taskId/completion/external-deliveries`: append an immutable,
  compare-and-swap adoption record. Session IPC and generic resource registration
  cannot create this authority.

The exact strict input schema is `ExternalDeliveryBindingInput` in
`apps/server/services/tasks/external-delivery-schema.ts`. It requires a stable
request key, expected contract and binding revisions, the original server owner
approval event, and the existing owner's comment ID and SHA-256 of its UTF-8 body.
Each delivery names its repository, PR, canonical independent source directory,
branch, reviewed head, base branch, expected merge commit and existing evidence.
The merge-order array must cover the complete delivery set.

Evidence is either an exact GitHub Actions run/workflow/head, independently read
from GitHub, or a canonical regular report file with SHA-256 and reviewed head.
The supervisor explicitly attributes existing local-report evidence to that head;
these reports remain **owner-attested**, not CI. Historical report bytes are not
edited to insert a SHA or manufacture new test results. The old product snapshot
cannot substitute for either delivery's external evidence. GitHub reads also
check PR identity, merge state, current base ancestry, ordered merge times and
any required review.

Adoption names every current resource ID, the exact source-copy resource, and
explicitly owned additional paths inside that root. Unknown kinds/purposes,
unexpected files, shared hardlinks and changed identities are refused. Ignored
files inside a source checkout, such as installed dependencies, need explicit
owned paths. Browser credentials remain opaque; the original immutable pinned
tooling checkout and task profile marker determine browser ownership.

After adoption, task reads advertise `finalizationVersion: 2`. A compatible
Drafted client sends `{requestKey: "finalize:<taskId>", finalizationVersion: 2}`
to the existing prepare/confirm endpoints. The server rejects v1 for a bound
task. Preparation requires the original open primary, complete/unpaused task and
current linked issue in Merge. It freezes both delivery evidence and the full
resource inventory before returning cleanup authority. The receipt's
`doneHandoff` is the only accepted terminal publication payload.

Full prepare calls revalidate the remaining inventory and independent provider
identity between resources. During bounded deletion batches, an existing
unconfirmed v2 preparation may use `authorityOnly: true` to recheck current
owner/source, task, contract, binding, verification and registry identity without
rehashing the whole tree. It cannot create a preparation or confirm cleanup.

Confirmation independently checks physical absence and original Git worktree
deregistration. Released registry state alone is insufficient. Only exact
provider-verified PR/CI references in the frozen plan remain retained history.
After confirmation, task reads expose their linked `finalizationRetention` receipt
even after the primary closes, so maintenance does not attempt to delete them.
New resources, changed metadata, missing proof events, edited acceptance,
superseded contracts or revoked verification block reuse.

Deployment applies the additive `20261029220000_external_delivery_receipts`
migration before enabling this server version. The new partial unique index
affects only supplemental binding, observation and resource-proof events; v1
event semantics remain unchanged. Installing these changes does not adopt a live
task, change its issue state, clean resources or deploy the previously accepted
external PRs.

The fixture suite uses disposable SQLite/Git directories and fake Linear/GitHub
reads. The optional cross-repository test runs the actual Drafted consumer:

```sh
DRAFTED_INTEGRATION_ROOT=/absolute/path/to/drafted bun test apps/server/services/tasks/external-deliveries.test.ts
```

It covers all eight resource kinds/instances used by this recovery, a failure
after an evidence file is removed but before its receipt is saved, same-key
resumption, confirmed retention and publishing Done before closing the session.
