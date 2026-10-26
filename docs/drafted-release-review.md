# Drafted workflow release review

Reviewed against this repository's AGENTS.md and Cubic's CLAUDE.md, service/route guidance and remote-agent operating patterns. Remote Agent's explicit control-plane architecture takes precedence where it differs from the Cubic product: the desktop uses TanStack Query, while product preparation and verification policy stays in the external Drafted repository.

## Findings corrected

1. **Repository removal expanded permissions.** Removing a connection's final selected repository changed the scope to `*`, authorizing unrelated and future repositories. Removal now retains an empty explicit scope, which disables intake. The schema and existing scope editor support that state; the regression verifies that adding another repository cannot reactivate the connection.
2. **Direct launch retries did not persist their content identity.** Concurrent requests compared prompt/provider fingerprints, but later retries only checked repository, branch and machine. The fingerprint now persists before preparation and survives restart. A changed prompt/provider fails closed. Legacy direct launches without a fingerprint must be inspected and continued by task identity rather than guessed equivalent. The additive migration preserves all task, session and resource identities.
3. **Pinned tooling could execute local modifications.** Checking HEAD alone did not prove that a cached checkout still contained its committed policy. Preparation now rejects tracked or untracked changes and preserves them for reconciliation. Ignored installed dependencies remain supported. Tests exercise both modified and untracked policy.
4. **Automatic plan capture used the default Linear connection.** A plan from another connection could use the wrong credential/workspace. Reads, description updates and status transitions now use the source link's connection and session repository. A regression verifies all three operations without changing the default configuration.
5. **New worktrees could start from stale remote-tracking refs.** Remote branch bases now require a successful targeted fetch before resolving and recording the starting commit. Parallel launches can share an in-flight fetch; subsequent launches fetch again. Failed fetches block creation instead of using cached code. Existing task receipts keep their original base, worktree and edits through retries. Explicit local branches and commit pins retain their meaning. Real Git fixtures cover fresh commits, parallel creation, unavailable remotes, retry recovery and preservation of dirty work.

## Reviewed boundaries

- Desktop host-qualified routes, requests, drafts, explicit saves and stale-revision protection; all-machine repository and session listings; secret markers restored only at their original field; private SSH preview transport.
- Stable ACP session ownership across Cubic and Drafted, collision rejection, most-specific worktree routing, and failure without replacing existing conversations.
- Signed Linear intake, actor filtering before launch, app-token renewal, issue-bound question and evidence delivery, durable instruction outcomes, per-host turn capacity and explicit control handoff.
- Exact worktree/resource ownership, immutable tooling selection, additive database changes, review retention and recovery without resetting product work.
- Existing kernel/server/desktop dependency boundaries and product-independent tooling composition. No Greenfield stack, dependency or tracked configuration adoption changes are introduced.

## Release limits

Passing automated checks does not establish the remaining product integrations. The Air's headless browser verification, Clerk test authentication and evidence receipts are maintained in the Drafted homebase acceptance document. Billing/GPU callbacks, successful site geometry and actual 3D interaction remain separate live checks. Cloud-preview lifecycle and a second physical host remain explicitly deferred by the owner.

Do not describe this draft release as full-plan acceptance or merge it on the basis of build success alone. Preserve the existing owner gates and task pins when deploying fixes; apply the nullable fingerprint migration while the owning daemon is stopped with a database snapshot.
