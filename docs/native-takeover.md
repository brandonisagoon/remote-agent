# Native ownership and accepted managed launches

DRA-299 adds an explicit owner control, rather than interpreting issue prose or
reaction removal. It preserves the configured workflows and original task
families. Deployment/test evidence is separate from live handoff acceptance.

## Owner contract

`GET /api/launches/native-takeover` takes query parameters `connectionId`,
`repositoryId`, `issueId` (Linear UUID), `issueIdentifier`. `POST` takes:

```json
{
  "source": {"connectionId": "connection", "repositoryId": "repository", "issueId": "uuid", "issueIdentifier": "TEAM-123"},
  "expectedRevision": 0,
  "requestKey": "immutable-owner-intent",
  "nativeChat": {"threadId": "actual-native-chat", "hostId": "actual-client-host"}
}
```

Use the source's recorded execution host. A known placement on another host is
refused. Both routes explicitly install `apiAuthMiddleware`, even when the outer
Unix socket uses `trustLocal`. Its existing `config.apiKey` bearer is the actual
credential, not a native chat ID, report origin or managed session ID. The owner
MCP exposes inspect_native_takeover/take_native_ownership only with `--config`;
these tools are not injected into managed task MCP. Task environments receive
session identity/socket, not this bearer. This excludes ordinary managed control
calls, not a hostile process under the same OS account reading host credentials.

A repeated key must have identical parsed input. Expected revision applies to a
new decision; replay returns the original applied decision's current disposition
and cannot reapply an old takeover over a newer grant. A native decision pauses
all exact open source tasks in the same transaction as installing its fence.
It then calls the existing family pause helper, including parallel cancellation
and actual inactivity rechecks. Pending/failing cancellation, a resumed task or
live ambiguous/independently owned linked session keeps `state: pending` (202).
No independent task is cancelled merely from its ancestry. `state: native` is a
verified current disposition; a superseded response is not native authority.
Queued results, original source, pins and historical receipts are preserved.

## Storage and execution boundary

One migration creates two small models. `NativeTakeover` is a source CAS head:
unique sourceKey (SHA256 of Linear/connection/repository/issue UUID), unique
(connectionId,repositoryId,issueIdentifier), recorded machine, revision, mode,
exact grant key/session, settled flag and decision time. `NativeTakeoverEvent`
is append-only native/managed/reconciled history with unique(controlId,requestKey),
sequence index(controlId,sequence), input digest and JSON provenance/progress.
Reconciliation uses separate namespaced keys and does not replace decisions.

TaskPlacement still owns ingress routing. WorkerRun status can be reset by a
replayed dispatcher and changed by a late finish; neither it nor delivery
receipt status is an execution fence. Session metadata requires a session and
cannot cover an accepted launch with no task/session. The new head covers that
case without creating a managed task or a general workflow executor.

The fence logically withdraws older accepted starts, including unknown delayed
work. Its receipts retain accepted runs and locally known pending ingress IDs.
Outbox deliveries can still be acknowledged normally: comments/results are not
dropped, and a withdrawn launch does not wedge later deliveries. Known withdrawn
starts return ignored before provider lookup; fresh provenance follows the normal
issue lookup. The guard covers workflow entry/plan continuation, transactional
task creation, completion of provisioning/composition, session binding, enqueue,
inbox claim and the actual acpx start after asynchronous setup. Cancellation's
abort signal is rechecked immediately before that synchronous start. Only the
freshly granted original primary and its recorded descendants can subsequently
execute; invalid/cyclic/cross-owner lineage fails closed.

Owner takeover and grant requests serialize on the existing process owner while
an original cancellation is in flight. This is request serialization, not a
second cancellation executor or background orchestrator. The durable head is
still authoritative after restart; an incomplete reconciliation remains pending
and the same owner intent can reconcile it. No old partial progress grants work.

## Fresh owner work

The existing owner-bearer `POST /api/launches` accepts optional
`nativeGrant: {issueId,expectedRevision}` with an explicit immutable `launchKey`.
For fenced sources this is required and bound to the full parsed launch request.
Unfenced requests retain their ordinary behavior. A single existing original
family requires its exact worktree/branch and is continued on the same primary;
its instruction is queued durably while its selected pause is released. Multiple
or unbound original families fail closed. The current revision must have
completed native reconciliation. `launch-pending` denotes a grant awaiting
session binding; `managed` is intent disposition, not delivered implementation.
Old accepted keys cannot consume another launch's grant.

A configured owner reaction can also provide fresh intent if its signed original
`data.createdAt` is present, valid, not in the future and strictly later than the
current decision. The owner must match the existing repository subscription.
Arrival time/webhookTimestamp is never substituted. Missing/old provenance stays
fenced. A verified fresh reaction resumes one original family; planning primaries
still use the existing provider/workflow continuation path. Repeated delivery of
that reaction cannot become a new grant. Actual availability of original creation
time in provider deliveries remains a live acceptance fact, not an assumption.
No new owner approval question is introduced; an already-authorized explicit
launch uses the supported existing endpoint when reaction freshness is unknown.

## Release and acceptance

Release the server plus migration first, then the paired Drafted instructions.
Drafted needs no new CLI command or runtime change. Preserve existing task pins,
protected owner pauses and unrelated source ownership. Do not recreate DRA-298,
unpause it, or create production fixtures solely to demonstrate this change.
The incident's reaction-removal ordering remains unknown. Unit/control tests
exercise accepted pending work, provisioning/composition/task/start races, family
failure/delayed terminal, restart/dedupe, auth and fresh owner continuation.
Live pending-launch/active-family acceptance must be reported unperformed unless
legitimate authorized cases are actually available and verified.
