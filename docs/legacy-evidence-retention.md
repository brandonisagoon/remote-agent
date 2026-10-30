# Legacy evidence retention

Older evidence receipts can contain `bytes` instead of `size`/`byteSize`, use an
original path without the task ID, or lack a historical digest. These facts do
not authorize the ordinary evidence adapter to delete a file. DRA-185 adds a
separate owner-authenticated retention proof for the complete remaining evidence
inventory of an already prepared version 1 finalization.

The old preparation, task/session identity, tooling pin, receipt paths and
metadata remain unchanged. Already released resources remain released. This
does not adopt external deliveries, waive completion verification, change the
source issue state, or resolve other providers such as an unclaimed Clerk
instance.

## Prepare and adopt

The owning primary can use Drafted's `evidence prepare-retention` command to
prepare an adoption JSON file from current receipt IDs and retained copies.
This is read-only apart from creating the proposal file; it has no owner API
credential and cannot adopt or retire anything.

An owner-authenticated `POST /api/tasks/:taskId/legacy-evidence` accepts
`LegacyEvidenceAdoptionInput` from
`apps/server/services/tasks/legacy-evidence-schema.ts`: a stable request key,
the exact existing finalization request key/revision, a private retained
manifest path/hash, and each original resource ID with its retained path,
observed SHA-256 and size. Authentication is required even over the local
control socket.

The server independently observes the original files and every retained
manifest member. The existing manifest format is supported:

```json
{
  "task": "original-task-id",
  "retainedArchive": "/absolute/private/retained-archive",
  "files": [{ "path": "capture.png", "sha256": "64-lowercase-hex-digits", "bytes": 1234 }]
}
```

The manifest is at most 8 MiB, with at most 10,000 members and 512 MiB total.
All archive directories must be owned and mode 0700; files must be owned,
unshared regular files with mode 0600. Symlinks, conflicting size fields,
changed bytes, duplicate original paths, receipts created after preparation,
and copies within cleanup roots are refused. Captured originals must also
remain outside registered whole-tree cleanup roots. Historical archive input
paths are never silently relocated: the submitted retained path must be an
actual member of the pinned current manifest.

Cleanup roots use actual unreleased browser/development/review dispositions. An existing tooling-purpose retained parent is not scheduled for whole-tree removal. Exact server-verified saved archives are likewise retained; arbitrary metadata cannot grant that exclusion. See [saved archive retention](saved-archive-retention.md).

When an old hash exists it must match. When it does not, the separate proof
records `digestProvenance: "observed-at-adoption"`; it never inserts a hash into
the old receipt or claims that the observation happened earlier.

Adoption may preserve proof while a task is waiting or its source is Blocked.
It grants no cleanup permission. The same adoption replays exactly; different
input cannot broaden or replace it. Owner pause, replaced contracts or task
identity changes stop reconciliation.

## Retire and confirm

Task reads expose the immutable `legacyEvidenceRetention` proof and a
`legacyEvidenceRetentionRequired` flag. The flag remains when the proof becomes
invalid so a client cannot fall back to ordinary unlink cleanup.

The original primary calls
`POST /api/sessions/:sessionId/legacy-evidence` with the exact proof digest,
proof/preparation revisions, finalization key and resource key:

- `inspect` verifies the retained files and intact/pending/captured original.
- `authorize` additionally reuses the current ordinary finalization authority.
- `confirm` additionally requires the original path absent and its exact inode,
  mode, size and digest in the proof's sibling quarantine, with the durable
  task/resource/plan-bound journal and retained archive still verified.

Drafted captures the file through an exclusive, descriptor-bound native rename
into a private sibling quarantine. It does not unlink any bytes. Confirmation
alone changes the original receipt's state to `released`; generic resource
updates cannot perform that transition or rewrite its bound identity. Lost
confirmation responses replay the same server event and preserve both copies.
Current finalization authority is checked before and after file observation.

This evidence proof does not finalize the task. Any unrelated unreleased
resource continues to block the existing finalizer. Source publication and
session closure remain the last ordinary lifecycle steps.

## Verification and release

`legacy-evidence.test.ts` uses disposable SQLite, Git worktrees, files and HTTP
routes. Set `DRAFTED_INTEGRATION_ROOT` to a checkout containing the matching
Drafted adapter to run the actual native capture and Unix-socket integration,
including a committed confirmation whose HTTP acknowledgment is lost.

Apply additive migration `20261030060000_legacy_evidence_receipts` through the
supported stopped-service updater. Its partial unique indexes enforce one
immutable inventory per primary/task and one confirmation per resource; no old
receipts are rewritten. Release the server endpoint and matching Drafted capability before live
adoption. Select that immutable capability without repinning the task. The
original primary must resume its existing preparation under current valid
completion authority. Implementation tests are not evidence of live retirement.
