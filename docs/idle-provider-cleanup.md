# Release idle providers for original-task cleanup

A completed ACP turn can leave its provider process warm with the original
checkout as its working directory. The unchanged cleanup observers correctly
refuse to capture that directory. Cancelling an idle turn does not release the
transport; closing the logical session would discard the original owner needed
for cleanup.

Owner-authenticated external-delivery adoption and the existing automatic
cleanup request now release the exact idle original provider family before
physical inspection. This is part of those existing operations, not another
approval. Scheduling resolves its exact immutable cleanup capability before
releasing any transport. Runtime reservations refuse active/queued local turns; database checks
refuse active, provisioning, uncertain, foreign or unrelated sessions and pending
open-family instructions. Delegate membership follows recorded `spawned-by`
relations. Closed delegate history is preserved. Separately closed unrelated
sessions remain historical records only: a read-only runtime check must match
their exact provider identity and independently prove its process absent. They
are never added to the owned close loop. An open foreign session, a closed row
with a live provider, or an unavailable historical identity still blocks the
transition. A provider record without a
locally held transport must independently prove its recorded process stopped;
it is never adopted or signalled by PID.

The existing inbox also performs this transition for a marked cleanup instruction
queued before this feature was installed. It preserves the exact instruction and
marker, excluding only that still-queued instruction from the pending-family
check. Every transport effect and binding transaction rechecks its saved bytes,
current acceptance and all other work. A lost transition response resumes the
same queue item; an already claimed cleanup cannot fall back to source execution
without the transport binding. Ordinary follow-ups remain visible and take
precedence through the existing inbox rules.

The runtime uses acpx's supported `close` with `discardPersistentState: false`
to unload only its held transport, then observes process absence. Task/session
rows, logical cwd, role, history, provider conversation IDs, branches and tooling
pins remain unchanged. One immutable metadata transition binds those identities
and a private execution directory outside the checkout. Its partial unique index
allows one transition from each prior revision.

The existing marked cleanup inbox instruction resumes the **same** persistent
provider conversation in that directory. A connection-local session-store view
supplies the execution cwd to supported ACP resume/load while every saved record
retains its original cwd and history. Persistent acpx refuses a replacement
conversation when resume is unavailable. No new executor, primary or cleanup
authority is introduced. The existing finalizer still proves archive equality,
resource ownership, inactivity, capture identity, pause/revocation and the
executing original cleanup turn before effects. The source root is not exempted
from any process or open-file check.

Ordinary follow-ups and delegate work stay queued while cleanup transport mode
is selected. They are neither executed in a surprising directory nor marked
handled. An owner/supervisor can explicitly return to work through
`POST /api/tasks/:taskId/completion/cleanup-transport` with
`{"mode":"work","revision":<current revision>}`. This releases the idle
cleanup transport and requires the original directory's exact device/inode;
removed or replaced source paths cannot be reopened. Read-only
`GET .../cleanup-transport` returns the current revision and any identity/pause
blocker. These routes require the owner API credential even over local IPC. Reads have
the existing 60-second application deadline and transitions the 240-second
adoption deadline. Cancellation is checked before each transport close and
inside the binding transaction before its write and return. A late binding
rolls back; a retry after an acknowledged provider exit does not respawn it.
`{"mode":"cleanup"}` provides the same idempotent transition for inspection
and recovery; ordinary adoption/scheduling calls it automatically.

A confirmed finalizer can close its original logical session after restart
without launching a new provider in the absent checkout. Existing logical close
semantics remain separate from idle transport release.

Daemon shutdown also releases its locally held idle transports through that
same public lifecycle, after its existing active-turn cancellation handling.
It observes the recorded provider exit, preserves logical rows/conversations,
and refuses late starts while shutting down. Unsettled active or unheld providers
are never converted to idle ownership. Deployment must still quiesce active
work and independently verify the old provider families absent before activating
a replacement; neither process exit nor launchd job removal alone is that proof.

## Verification

Disposable real ACP subprocesses retain cwd between turns and record actual
spawn/load/exit events. Tests cover the primary plus delegates, live foreign
runtime refusal, active work, pause and concurrent turn reservations, exact
pin/directory changes, source removal, restart, preserved follow-ups, return to
work, automatic scheduling and lost-response retry. An opt-in actual Drafted
pair validates and restores the archive, then captures the dirty original and
Git administration during the same resumed primary turn using the unchanged
root-idle observers and native capture engine. It verifies staged and unstaged
bytes survive and an acknowledgment retry does not repeat capture.

Run the pair with `DRAFTED_INTEGRATION_ROOT=<reviewed Drafted checkout> bun test
apps/server/services/tasks/cleanup-transport.test.ts`. No live provider, task,
archive or product resource is touched by these tests. Live acceptance remains
a release-owner step on the original tasks.
