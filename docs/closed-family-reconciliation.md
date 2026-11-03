# Closed-family instruction reconciliation

This operator control API settles the durable inbox of an original persistent
delegate after its task and primary are already closed. It never starts,
reopens, closes, or signals a provider. Ordinary instruction resolution retains
its existing closed-task guard. No repository configuration or MCP tool enables
this exception.

Use the existing authenticated task API:

1. POST `/api/tasks/:taskId/closed-family/prepare` with `requestKey` and `scope`.
   Scope selects the exact original primary, delegate, repository, machine,
   absolute worktree path and tooling revision. Save the returned preparation
   and inspect its original instruction hashes and provider history digests.
2. POST `/api/tasks/:taskId/closed-family/commit` with the identical selection,
   `preparationDigest`, a reason and an `acknowledgeUnknown` entry for every
   unknown instruction. Each entry includes its ID, exact text SHA-256,
   provider history digest and a review reason. Missing, duplicate, foreign or
   mismatched acknowledgments refuse the entire transaction.
3. GET `/api/tasks/:taskId/closed-family/receipts/:requestKey` for the committed
   receipt. An identical commit replays that receipt. Reusing a key for another
   owner, preparation or decision refuses. Changed provenance invalidates
   receipt readback.

The runtime reserves all original family sessions and refuses active turns,
queued turns, handles, recovery, release, execution-directory ownership or
shutdown. It reads original provider records twice, verifies their exact
session identities and worktree, and requires recorded-PID ESRCH or confirmed
recorded exit evidence. It does not accept a caller's provider-stopped flag.
Provider records must remain unchanged throughout the reserved transaction.

Unknown delivery requires its original request identity and exactly one matching
user instruction followed by the final agent response, with no retry or terminal
lifecycle evidence. Operator acknowledgment changes only inbox delivery state;
the audit preserves execution outcome `unknown`. A final text response does not
prove successful execution. No completed lifecycle event is synthesized.

A queued instruction can be cancelled only with unchanged creation/update
metadata, no execution request, no lifecycle or resolution history, no matching
provider user text, and a valid provider watermark predating creation. Otherwise
preparation refuses rather than inferring non-delivery from the queue label.

Commit checks the prepared SQL snapshot again and uses compare-and-set updates.
Instruction text remains unchanged. Logical delegate closure, ending its
original parent relations, and the immutable receipt commit atomically with
instruction dispositions. Failure rolls everything back. The receipt retains
original task/session/relationship bindings, instruction hashes, provider
record/history digests and each operator decision. It grants no authority to
stop resources, remove worktrees, adopt PIDs, or release compute.

Source verification and disposable tests do not authorize a live reconciliation.
Before any live use, review the exact source, run release gates, deploy that
revision, and inspect a new preparation from the original owner.
