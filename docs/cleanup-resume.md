# Resume an interrupted cleanup

A task may already have an owner-approved, verified and merged delivery with a
frozen v1 finalization preparation, then enter Blocked while an adapter is being
fixed. The normal agent issue publisher correctly refuses Blocked → Merge. A
fresh human Merge transition would create a new completion contract and make
the original preparation stale.

The server exposes an owner/supervisor bearer API for this specific continuation:

1. `GET /api/tasks/:taskId/completion/cleanup-resume` returns the existing
   `preparedRevision`, `requestKey`, `bindingDigest`, `expectedStateId` and
   `expectedUpdatedAt`, together with current source/task state. The key is
   deterministically bound to the preparation and that exact Blocked revision.
2. `POST` to the same path with those exact values, `expectedState: "Blocked"`,
   and a short `basis`. Include the returned expected state ID/timestamp. The
   request field for the digest is `expectedBindingDigest`. Keep the complete
   request unchanged for retries. After persistence, GET also returns that
   immutable `request`, including after a lost publication acknowledgment.
3. The existing original primary can retry its existing finalizer request after
   the operation confirms source Merge and task phase complete. Resource adapters
   and the normal finalizer retain all of their own current checks.

Both operations require the configured owner API bearer even on trusted local
IPC. There is no agent tool or unauthenticated local variant. The endpoint does
not change the completion contract, verification, preparation, primary, paths,
tooling pin, resources or session lifecycle. It does not perform a merge, launch
a new session, close the original primary, or claim that cleanup has finished.

The immutable continuation receipt binds the original task/session/source,
contract and verification revisions/digests, preparation bytes, tooling identity,
and exact merged PR/head/base. Before publication the server independently checks
the current provider merge/base ancestry and the unchanged original worktree, or
its independently observed path and Git-registration absence after partial
cleanup. It rechecks the local snapshot after the provider observation. A newer
contract, verification or preparation, a changed identity, an explicit pause, or
a closed primary refuses continuation.

The configured connection must independently identify its authenticated viewer
as the service actor, and that actor must not be subscribed as an approving owner.
The service performs only the expected Blocked → Merge state update. Its exact
persisted source/actor transition is ignored by the issue workflow handler,
including delayed webhooks, so it cannot create another Merge workflow or human
approval receipt. Unrelated issues, connections, actors and transitions retain
normal webhook handling.

The pending receipt is saved before publication. The original state ID and
`updatedAt` are rechecked before the effect; a different state or a newer Blocked
revision stops the pending request. Linear does not expose an issue-update CAS in
this operation, so a concurrent external change during the network write cannot
be made atomic with the local transaction. The server observes the source again
after publication and rechecks task authority before atomically recording
confirmation and restoring phase complete. An applied write with a lost response,
or a failed confirmation transaction, can reconcile the same pending request
without another source write. Completed replay reports current state and never
rewinds a later owner decision. After another cleanup blocker is resolved, the
owner/supervisor can inspect and submit a fresh request for the new Blocked
revision while retaining the same original preparation, approval and tooling.
Older pending attempts are superseded; older confirmed requests only replay
their result and cannot reset the later state or bypass an explicit pause.

The additive SQLite migration gives pending and confirmed receipts separate
unique keys for each exact source revision. Run normal migrations before deploying this server revision. This
bounded API accepts original Merge-based v1 preparations only. External-delivery
v2 and Done-retirement preparations retain their separate authority paths.

Disposable real Git/SQLite tests cover the original publisher refusal, unchanged
preparation bytes, pending/confirmed service-webhook suppression, lost provider
acknowledgment, confirmation rollback, concurrent retry, a second blocker and
continuation using the same preparation, new owner decisions,
pause and ownership changes, dirty work during slow observations, missing
worktree registration, and bearer-only routing. An unresolved Clerk fixture
remains unreleased and still prevents finalization. No live task, provider state,
credential, cleanup or deployment is part of this implementation verification.
