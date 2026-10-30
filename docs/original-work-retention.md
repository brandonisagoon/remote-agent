# Original unfinished work and external delivery

Owner-authenticated external-delivery adoption may include `originalWork`. This
keeps accepted external pull requests distinct from the original unfinished
checkout. The existing owner approval, comment, exact PR heads, merge ancestry,
CI/report evidence, task identity and pinned tooling remain required. The
original HEAD and branch must still match the original approval; dirty contents
are preserved, never represented as an additional delivered merge.

The owner selects an existing `source-archive` resource, its manifest digest,
bundle/ref, staged patch, unstaged patch, untracked tar, expected working tree,
and explicit ignored-material paths. The server independently hashes every
manifest member and refuses unmanifested files, links, shared files, unsafe
paths, nonprivate archives and oversized inputs. It restores the bundle and
patches in a private temporary Git repository. Only this temporary repository
receives index/object writes. Thin-bundle prerequisites come from the original
repository's retained objects; their IDs and the retained original branch are
rechecked on replay. Tar members are decoded as bounded regular files, never
extracted with archive-selected links or traversal paths.

The restored staged tree, working tree and working-content fingerprint must
match the original. The frozen receipt then includes the entire original
directory inventory and a unique sibling quarantine target. The Drafted client
captures that exact root with its existing descriptor-bound mechanism, then
captures its exact per-worktree Git administration using the same mechanism.
Git is read-only throughout retirement. The branch, archive, source capture and
complete saved index/administration remain available. A missing original
without a matching capture is not proof of retirement. Confirmation independently
observes the archive, capture and Git-registration absence before the exact Done
handoff can be published or the primary closed.

`retain-archive` applies only to an independently verified selected archive.
Additional archives support either normalized SHA-256 lines or a bounded JSON
manifest with exact `root` and `files[{path,bytes,sha256}]`. `retain-result` is
limited to explicitly selected historical Rubin chats, property revisions and
Studio site snapshots whose unique key/kind/purpose/external ID occur in a
manifested provenance record for this task and original tooling pin. These are
historical references, not newly verified product acceptance. Exact
`delivery-receipt` and `github-pull-request` aliases use the existing independently
observed PR identity; unrelated PRs remain blocked. Previously released records
remain immutable `already-released` entries with no new effect authority.

Resource sets may contain up to 1,000 exact records. A source-copies receipt is
optional only for this independently verified original-work path; no replacement
resource is manufactured. Unknown open resources still block adoption with their
keys and kinds. Physical/provider resources need their own concrete ownership,
capture or absence proof. No resource kind, model-authored metadata, or archive
alone exempts those resources from cleanup verification.

Existing v1 receipts and clean v2 behavior remain unchanged. Adoption cannot
replace an existing preparation. Same-key retries retain the immutable original
plan; changed owner authority, source bytes, archives, resource identities or
retained branch refuse further effects. Tests use disposable repositories and
files, including the actual Drafted finalizer, capture interruption, a lost Done
response, and close-last ordering. No live DRA98 adoption or cleanup is implied
by these source tests.

## DRA98 execution inventory

The read-only inventory on 2026-10-30 contained 149 records: 18 already released
and 131 open. This change can bind the original dirty worktree and retain five
exact accepted-delivery references, eleven archived logical-result references,
and two independently verified archives. It does **not** make the remaining 113
open records executable through v2 finalization:

| Records | Required execution proof |
| --- | --- |
| 95 evidence files and 2 scenario seed files | Exact standalone file capture; depend on DRA185's native capture instead of adopting their entire parent directories. |
| Private environment directory and its contained candidate environment file | Explicit whole-directory capture with both exact registered identities and every other directory entry preserved. |
| 3 delivery Git worktrees and 1 rejected-work checkpoint directory | Exact directory capture and, for worktrees, independent Git-registration retirement. |
| 1 browser profile | Exact named-session stop and profile/marker/context preservation without reading cookies. |
| 2 Clerk records, 2 S3 objects, 2 DNS records and 1 tunnel | Concrete provider ownership, operation and independent absence checks. Shared or staging data must not be deleted to empty the inventory. |
| 1 local HTTP endpoint and 1 task-runtime receipt | Exact process/service ownership and independent stopped/listener-absent observations. |

The registered task-runtime receipt identifies a JSON file, not ownership of a
whole parent directory. Evidence lives in several standalone review/evidence
locations. No common ancestor is inferred as an owned cleanup root. The private
environment is absent from the source archive; the receipt cannot claim those
bytes were already backed up there. DRA187's separately reviewed inactive-socket
inventory support may also be required for concrete directory captures.

Original and captured roots must pass process/open-handle checks at execution.
A persistent primary/provider process using the worktree can block that check;
phase `complete` is not a substitute for observing inactivity. No live DRA98
archive validation, provider mutation, process stop, adoption or cleanup was run
while implementing this change.

## Existing base/work recovery archives

`OriginalWorkInput` also accepts `format: "base-work-tar/v1"` for an exact
`recovery-archive` resource with its existing `tooling` purpose. The selection
pins `manifestPath`/`manifestSha256`, relative `receiptPath`/`receiptSha256`, and
relative `checksumsPath`/`checksumsSha256`, plus explicit `ownedPaths`. It does not
invent a bundle, rewrite the receipt or rebuild the backup. The original bundle
input and DRA190 saved-archive formats keep their existing rules.

The historical receipt must bind the current task, source path, archive path,
base commit, branch and original tooling revision. Its checksum list and the
selected checksum document must agree on `base.tar.gz`, `work.tar.gz`,
`index.patch`, `tracked.patch`, `status.porcelain`, `base-tree.txt`,
`changed-files.txt` and the selected manifest. Any recorded resource digest must
also agree. The file-array manifest records each product path, file/link kind,
size, SHA-256, executable mode and tracked/changed classification.

Verification streams the compressed archives through held no-follow descriptors
with declared byte and entry bounds. The base is compared with the original Git
tree and restored into a private temporary repository. Exact staged and unstaged
patches are applied there; the mixed work tar verifies all changed files and
supplies untracked files. The entire restored manifest and Git snapshot must
match the original, including staged/untracked classification. The source is
re-read before returning. Original Git objects and index are not written.

Only relative tracked symlinks staying inside the restore are supported; no tar
member may traverse a file or link. Hard links, devices, duplicate/unlisted
members, traversal and changed hashes are rejected. Paired AppleDouble records
and the known libarchive provenance PAX attributes are bounded metadata covered
by the compressed checksum; they are never extracted or applied. Gzip checksums
and complete tar end markers are consumed before accepting the result.

The original archive root must remain private 0700 and user-owned. Existing 0644
files behind that root are preserved as recorded. The complete retained inventory
also freezes interrupted archives and prior restore directories as newly observed
ancillary material; those bytes never become authoritative restore inputs.
`retainedArchiveMembers: [{resourceId}]` may select an exact `resource-inventory`
tooling receipt whose task-bound regular file lies in that inventory. Its distinct
`retain-archive-member` plan binds the parent archive, path, size, hash and current
resource identity. Both records remain Ready, and all task records remain counted.
Other tooling resources receive no exemption.

Read-only DRA42 verification on 2026-10-30 at 05:28:06 UTC independently restored
all 10,267 members and 14 dirty files from the unchanged 1,084,954,888-byte base
archive in 67.2 seconds under concurrent test load. Manifest `f19388f3f2a001d38c387544e578bbdb0b22cba52ecda3e7613a4fd2ae31a077`
remained unchanged. Evidence: `/private/tmp/dra192-dra42-readonly-restore.json`.
No live adoption, preparation, resource write, process action or cleanup ran.

Validation: the full server suite passed 796 tests with 3,694 assertions across
107 files, including actual Drafted integration; one existing opt-in large
archive test was skipped. Typecheck and desktop build passed. The client full
suite passed 392 tests with five existing opt-in skips. The final link-chain
guard was checked again with 33 affected native capture/restore/resource tests
and 128 assertions, plus lint and build on the final tree. Logs: `/private/tmp/dra192-server-final.log`,
`/private/tmp/dra192-affected-final.log`, `/private/tmp/dra192-build-final.log`.

This format support does not supply missing delivery/owner authority or physical
cleanup adapters. DRA42's current Done state still needs the separately supported
retirement/adoption path and exact plans for its remaining physical resources.
Deploy the server publisher before selecting the matching immutable Drafted
client; an old strict client refuses the added format/disposition.

## Additional registered linked checkouts

A `retire-worktree` plan covers an exact existing `git-worktree` resource and
its owner-selected path. It freezes the main/common Git directory identities,
per-worktree administrative directory, registration, HEAD and branch (including
an explicitly detached checkout), `.git` pointer and index. Dirty, split-index,
sparse and submodule states require a separate preservation plan and are refused.
No reset, relabel, prune, forced removal or branch deletion is authorized.

The whole checkout moves into its existing retained-quarantine protocol. Every
source and ignored file is inventoried, except exact untracked `node_modules`
directories with tracked package and lock files. Those dependency directories
remain in the capture, bound by directory identity and package/lock hashes; their
individual installed files are not content-hashed or deleted. All other ignored
material remains fully hashed.

After the complete checkout is captured, the same descriptor-bound mechanism
captures its exact small administrative directory, including `index`,
`logs/HEAD`, `ORIG_HEAD` and every other inventoried regular file. The inventory
is bounded to 256 entries, 16 MiB per file and 64 MiB total. Source and destination
parent identities and the filesystem are frozen; cross-device moves fail before
source effects. The administration quarantine is private 0700 and outside Git's
`worktrees` registration directory. Its parent must be user-owned and not writable
by other users; existing evidence capture keeps its stricter private-parent rule.

No Git removal command traverses the now-absent checkout path. A disposable test
proved that ordinary `git worktree remove` could delete a clean-looking replacement
with new ignored bytes created immediately before command dispatch. Exact native
administration capture preserves all metadata without that traversal. Read-only
Git commands verify registration absence afterward. The common repository, refs
and other registrations stay intact. Recreated checkout or administrative paths
remain untouched and block completion. Both captured inventories and journals
must verify; Released state alone is not a retirement proof.

Process checks enumerate bounded NUL-delimited open-handle records rather than
recursively traversing every installed dependency. Any handle or command naming
the checkout/capture rejects inactivity; unknown filesystem names and observation
errors also reject it. Darwin's explicitly typed anonymous pipes, network-policy
and nexus descriptors do not name filesystem nodes. The type distinction comes
from [XNU's process descriptor types](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h)
and [lsof's Darwin pipe observer](https://github.com/apple-oss-distributions/lsof/blob/main/lsof/dialects/darwin/libproc/dfile.c).
There is no process-ID or read-only-directory-handle exemption.

Disposable Darwin and Linux fixtures cover branch/detached registration, complete
administration preservation, captured/source substitution, captured-root retries,
package/lock changes and an actual process retaining its working directory. A
read-only DRA98 preflight covered all three linked checkouts, with six retained
opaque dependency roots each, and fully hashed 1.26–2.04 GB of other bytes per
checkout. The final run took 9.0–19.6 seconds per checkout. DRA8's review check
correctly refused its still-running API/web handles. These observations do not
adopt a plan, stop processes or remove any live checkout. Other unsupported task
resources still require their own exact plan before whole-task adoption.

## Legacy browser capture

A `retire-browser` plan keeps the original browser receipt and tooling pin. Its
session observation runs through the immutable cleanup capability selected by
the server, never through the receipt's historical `toolingRoot`. The exact
`drafted` namespace, task/purpose session, profile directory identity and private
ownership marker must match the supported legacy format.

When an existing registered private directory owns the browser parent, its
capture preserves the profile as one opaque child, the marker, offline command
context and every other inventoried file. The parent has a separate stopped
consumer edge for the named browser. A standalone browser uses only its exact
owner-selected marker/profile parent, with a complete frozen inventory and the
same native retained quarantine; no broader environment root is inferred.
Cookie contents are neither read nor individually hashed. The browser profile
is retained, not deleted.

Confirmation independently observes named-session absence through the configured
capability even after the original paths have moved, and verifies the marker and
profile identity at their captured paths. Released state alone is insufficient.
Active browsers require verified stop-only handling before capture; owner pause
is not overridden. The server fixtures cover both parent shapes, historical
metadata-tooling mismatch, source recreation, shared profiles, marker/context
substitution and capture replay. Live legacy adapter inspection and paired client
execution are separate acceptance checks; these schema/observer tests do not
claim a live browser has been stopped or retired.

## Archived-original administration recovery (DRA-201)

New original-work proofs bind the exact linked Git administration, its complete
index/inventory, and both source and destination parent identities. The source
is captured first; its administration moves to a second private same-filesystem
quarantine. A recreated original path—including ignored files—is never traversed
by a removal command and blocks completion. Shared Git refs and other worktrees
remain untouched. Read-only snapshot commands disable optional index refresh.

An older immutable preparation is never edited to add this target. Full
preparation may append one `finalization-original-administration` event, bound to
that preparation's revision/digest and the original-work digest. The additional
wire receipt is strictly parsed; old clients reject it before their old cleanup
path. Creating the supplement performs physical observations outside SQL, then
rechecks existing local authority and immutable preparation in a short transaction.
A unique index forbids alternate supplements for the same original finalization.
Authority-only renewal reads the saved extension without rehashing files.

If the source was already captured, a new extension must verify its exact saved
`.git` pointer, original index, staged/unstaged/untracked snapshot, and linked
registration. It cannot adopt whichever administration exists now. If historical
source capture and exact registration/administration absence are independently
verified, the extension records a null administration target: it does not claim
an administration capture happened. Already-confirmed historical receipts remain
valid without manufacturing that extension.

Full confirmation observes both retained inventories (or the explicit historical
absence), and links any extension revision/digest to the confirmation. Missing or
changed extension rows invalidate confirmed replay. Recreated paths, changed
parents/index/archive, active writers, owner pause and revoked authority preserve
all copies. No live task was adopted or retired by the implementation tests.

Release additive migration `20261030120000_original_administration` with the
matching Drafted capability. Existing pins, original preparation/binding bytes,
retained archives and finalization request keys stay unchanged.
