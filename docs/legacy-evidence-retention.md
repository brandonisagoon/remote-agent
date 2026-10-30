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
and copies within cleanup roots are refused. File captures must also remain outside registered whole-tree cleanup roots.
Directory captures use the separately pinned external destination described below. Historical archive input
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

## Directory evidence and historical task backups

The complete inventory can contain both the unchanged file entry and a typed
`{ type: "tree", resourceId, retainedPath, inventoryDigest }` entry. The latter
binds the full original directory inventory; it does not pretend a directory is
a file with a historical hash or byte size. Every source file must match its
independent retained member in the pinned manifest. The proof freezes source and
retained directories, files, modes, inodes and digests. Links, shared files,
unsupported entries, overlapping evidence/foreign task resources, unsafe modes,
changed parents and omitted evidence receipts fail before capture. Original
metadata and preparation bytes are unchanged.

For the existing DRA80 backup, explicit manifest format
`task-backup-evidence-v1` reads its task-bound `MANIFEST.json` and the four
hash-bound browser/worktree/runtime-config component manifests. It verifies every
component member with bounded streaming reads (10,000 members, 2 GiB per member,
4 GiB aggregate), preserving owner-only 0400/0600/0700 files without executing
scripts. Ordinary file-list manifests retain their original 512 MiB limit and
0600-file rule. The root and component documents are independently rechecked;
this evidence proof does not claim retention authority for unrelated backup
members or automatically exempt a `private-backup` resource from cleanup.

A directory can be nested under an environment scheduled for later removal.
Its retained quarantine is therefore an exact new slot beneath the existing
private parent of the archive, outside every cleanup root and on the same
filesystem. Both source and destination parent identities are frozen. Native
capture holds those parents through exclusive rename; it closes its own source
handles before refreshing authority, then reopens and verifies the exact source
through the held parent. The normal process/open-file observer has no PID or
read-directory exemption. Same-purpose registered writers must have completed
verified retirement before tree capture. Parent cleanup is guarded before client
adapter effects and before the server accepts its Released receipt, until the
child capture is independently confirmed. No bytes are unlinked from either copy.

Partial intent, completed capture and lost confirmation recover the same journal,
proof and preparation. A confirmed capture can still be inspected after its empty
original parent is removed. Recreated source parents, replaced retained bytes or
new overlapping ownership refuse continuation and preserve all material.

## Evidence added after cleanup starts

The existing authenticated retention adoption also supports an already-bound
version 1 cleanup operation. In the same transaction as its retained-evidence
proof, the server records a `finalization-cleanup-evidence-supplement` tied to
the exact original operation, preparation and raw retained-proof event bytes.
It does not rewrite those records or change the client operation witness.

Only this validated evidence addition can extend the frozen authority epoch.
The existing resource scope, task/pin identity, archives, owner revocation,
pause and automatic-turn checks still apply. Saved copies are fully observed
before adoption and independently checked by the normal evidence adapter
before capture and confirmation. Cheap operation renewals validate the local
binding without streaming the archives again. A retry reuses the same proof
and supplement, including after capture or a lost confirmation response.
Apply the additive `20261030190000_cleanup_evidence_supplement` migration through
the normal stopped-service updater; its unique index prevents duplicate
supplements. The existing endpoint and unchanged client protocol are reused.

DRA-209's disposable regression binds cleanup before adoption, then uses the
unchanged Drafted client to retire 20 files and one directory over the actual
control socket. It verifies retained bytes, lost-response recovery and exact
preservation of the preparation, operation and archive-proof events. No live
DRA-80 adoption or cleanup is claimed by these tests.
