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
captures that exact root with its existing descriptor-bound mechanism and
removes only the now-absent Git worktree registration, without force. The branch,
archive and complete captured directory remain available. A missing original
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
