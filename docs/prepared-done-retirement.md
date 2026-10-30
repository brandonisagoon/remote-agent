# Continue prepared cleanup after the owner marks delivery Done

An older task may already have a verified Merge-based v1 preparation when its
owner marks the shipped product Done. Cleanup can then be interrupted in a
waiting or blocked phase. The original preparation is still the correct plan;
moving the issue backward or issuing a replacement Merge contract would invalidate
that plan and any retained-evidence proof attached to it.

`/api/tasks/:taskId/completion/delivered-retirement` adds a present-day owner
supplement. GET inspects the current original preparation, source revision and
task/resource binding. PUT accepts `DoneRetirementInput` with
`mode: "existing-preparation"`, the exact inspected digests/revisions, a stable
request key, and the basis of the existing owner authorization. The completion
route requires the owner's API credential even over trusted local IPC. An
authorized supervisor can apply a standing instruction through this endpoint;
there is no additional human approval ceremony or fabricated historical comment.

Adoption independently rechecks the original verified PR head, merge and current
base ancestry, the configured Git repository and original worktree registration
or already-absent/unregistered worktree, current Done issue/version, original
primary, branch, pin, contract, verification and remaining resource identities.
It stores one immutable `prepared-done-retirement` event and restores only the
interrupted task phase to complete in the same transaction. It does not publish
to Linear, run a Merge workflow, change the checkout or pin, retire resources,
alter the original preparation, or rewrite legacy evidence/archive proofs.

The same preparation key now returns the existing v1 `retirement` response with
an exact Done-to-Done handoff. The underlying preparation bytes remain unchanged.
Each cleanup authority refresh checks the supplement, source and original
bindings. Existing resource adapters continue to prove their own targets. There
is no global DNS/provider preflight in adoption: an unavailable DNS read does not
block independently owned container or evidence work, but its unreleased receipt
still prevents final confirmation and closure. Recorded uncertain effects are not
reinterpreted as successful cleanup.

DELETE accepts `DeliveredRetirementRevocation` with the expected authority
revision. Revocation, owner pause, replaced preparation/contract/verification,
changed resource identity, or a source other than the bound Done state prevents
the next effect. Same-key retries recover the stored supplement without repeating
adoption. A failed transaction changes neither phase nor authority. Source reads
are refreshed after slow observations; there is no claim of an atomic transaction
between Linear and local filesystem/SQLite observations.

Confirmation independently checks resource completion, retained archive proofs,
and original worktree/Git-registration absence. The actual issue-publication gate
accepts only the exact supplemented confirmed handoff. Lost publication
acknowledgments reuse the existing routed comment and confirmation; the session
closes only after publication succeeds. A Done-to-Done handoff does not write a
new state or impersonate a human Merge event.

This unit targets DRA-80's existing preparation513/verification508/contract297
and DRA-99's preparation462 with retained-evidence proof515. Deployment and live
acceptance are separate. DRA-85's product check is not claimed complete by cleanup.
Unprepared older tasks such as DRA-42 and DRA-8 require the separately developed
delivery/correspondence authority and concrete remaining resource plans; this
endpoint does not bypass their missing proof or invent generic kind exemptions.

Tests use disposable Git repositories, SQLite databases and a private control
socket. They exercise stale ownership/resource/source changes, an interrupted
waiting primary, revocation, transaction rollback and durable uniqueness. Set
`DRAFTED_INTEGRATION_ROOT` to a frozen Drafted checkout to run the actual client
finalizer through the server prepare/confirm/publication gates with a deliberately
lost publication acknowledgment, proving the original records stay unchanged and
the same-key retry closes last.
