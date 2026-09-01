# acpx migration plan

- Status: Executed
- Last reviewed: 2026-09-01
- Scope: replace bb as Remote Agent's session runtime while preserving the
  Linear, HTTP, worker, and Zed workflows.

## Decision direction

Use `acpx/runtime` as the provider-neutral session, queue, reconnect, and ACP
client layer. Remote Agent will own the durable mapping between its issues and
acpx sessions, worktree placement, event projection cursors, and the ACP server
surface presented to Zed.

The Zed adapter and the acpx-backed runtime should be one Remote Agent process
and one session service. Zed must still connect to an ACP **agent** endpoint;
acpx is an ACP **client/runtime**, so the protocol boundary cannot disappear.
It can, however, become a direct in-process proxy instead of a separate bb
bridge with its own session model.

## bb functionality currently used

| Capability | Current use | acpx migration target |
| --- | --- | --- |
| Thread identity and lifecycle | Spawn, get, list, stop, and archive root and hidden execution threads | Store a Remote Agent session row mapped one-to-one to an acpx record/session ID; use acpx ensure, close, and cancel |
| Durable provider sessions | bb owns provider process/session recovery | acpx persistent sessions and provider `session/resume` or `session/load` |
| Queue ownership | Linear messages use `queue-if-active`; Zed prompts wait on turn completion | acpx queue owner and enqueue/no-wait APIs |
| Ordered event history | `listEvents`, `streamEvents`, and sequence cursors drive Linear and Zed projection | Subscribe to acpx structured ACP events and persist a Remote Agent projection cursor/event journal where replay is required |
| Provider and model discovery | Harness, model, reasoning effort, permission mode, and service tier controls | Preserve the upstream agent's ACP config options; use acpx runtime control APIs and their complete returned state |
| Execution placement | bb project, host, environment, and worktree IDs choose a machine and cwd | Remote Agent resolves configured repo/worktree paths; remote execution requires an explicit SSH/process transport because acpx has no bb-style host registry |
| Transcript/output lookup | Final output and replay are derived from bb events | acpx event history/session export plus a small normalized transcript projection owned by Remote Agent |
| Pending interactions | bb questions are translated to ACP permission requests | Forward upstream ACP permission/elicitation requests directly to the active client, with a defined unattended policy for webhook-only sessions |
| Cancellation | Stop an active bb thread | acpx cooperative `session/cancel`; close remains a separate lifecycle operation |
| Open in bb UI | Ask connected bb windows to show a thread | Remove or replace with a Zed deep link/session-open action; this has no acpx equivalent |
| Machine inventory | bb machine/host status supports placement | Replace with configured execution targets and explicit health checks, or declare local-only in the first migration |

## Zed integration surface

Remote Agent remains the ACP agent from Zed's perspective and delegates each
session to exactly one acpx record. The server surface consists of:

- initialization and capability negotiation;
- `session/new`, `session/load`, `session/resume`, list, close, and cancel;
- prompt forwarding and streaming `session/update` notifications;
- complete configuration state and configuration mutations;
- file, terminal, permission, and elicitation requests forwarded between the
  upstream agent and Zed when both sides advertise support;
- transcript replay on `load`, but not on `resume`, following ACP semantics.

Use a stable Remote Agent ACP session ID as the external ID. Persist this tuple:

```text
(remoteAgentSessionId, acpxRecordId, acpxSessionId, agentSessionId?, cwd, agentCommand, name)
```

Never derive a new acpx session merely from a new stdio/SSH connection. A new
Zed transport loads or resumes the existing mapping. This removes the duplicate
bb-thread symptom on SSH reconnect: a transport reconnect is not a logical
session creation. If the provider process died, acpx reconnects the saved
provider session; only an explicit Zed `session/new` creates a new logical
session. If acpx must fall back to a new provider-native session, update the
existing mapping and surface that recovery in logs rather than registering a
second Remote Agent session.

## Execution result

All five phases are implemented. The production dependency on `bb-app`, the
bb transport/event ingestor, bb configuration, thread links, host locators, and
legacy cursor table have been removed. Runtime identity and consumer cursors
now live in the existing Prisma/SQLite database. ADR 0002 records the final
ownership model.

## SQLite session registry

Extend Remote Agent's existing Prisma/SQLite database; do not introduce a
second application database. SQLite replaces bb's application-level thread
registry, while acpx retains its own implementation-level records under its
configured storage directory.

Ownership is intentionally split:

| Owner | Durable state |
| --- | --- |
| Remote Agent SQLite | Stable external session ID, Linear relationship, acpx identity mapping, repository/worktree placement, lifecycle state, projection checkpoints, and last-known ACP UI state |
| acpx | Provider connection metadata, resumability data, queue-owner lease, accepted config selections, and acpx event history |
| Provider agent | Canonical model conversation/context and provider-native session |

Remote Agent may cache complete ACP config options and the latest usage update
so Zed can render restored state immediately. Those fields are observations,
not a second source of truth: refresh them from acpx/upstream on every successful
load or resume.

Add an application-owned `RuntimeSession` table instead of putting more
runtime-specific columns directly on `AgentIssueRecord`. A runtime session must
be able to exist before, or without, a Linear mirror. The target Prisma shape is:

```prisma
model RuntimeSession {
  /// Stable Remote Agent ID; also used as the Zed-facing ACP session ID.
  id                    String   @id @default(cuid())
  /// Deterministic hash/key of agentCommand + absolute cwd + optional name.
  scopeKey              String   @unique
  acpxRecordId          String?  @unique
  acpxSessionId         String?  @unique
  agentSessionId        String?
  agentCommand          String
  cwd                   String
  name                  String?
  worktreePath          String?
  executionTarget       String?
  status                String
  latestConfigOptions   Json?
  latestUsage           Json?
  recoveryDetail        String?
  closedAt              DateTime?
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  agentIssueRecordId    String?  @unique
  agentIssueRecord      AgentIssueRecord? @relation(
    fields: [agentIssueRecordId],
    references: [id],
    onDelete: SetNull
  )
  cursors               RuntimeEventCursor[]

  @@index([status])
  @@index([agentCommand, cwd])
}

model RuntimeEventCursor {
  id               String   @id @default(cuid())
  runtimeSessionId String
  /// Separate consumers, for example `linear` and `zed-replay`.
  consumer         String
  /// Opaque acpx/event-journal checkpoint; do not assume bb-style sequence IDs.
  sourceCursor     String?
  generation       BigInt   @default(0)
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  runtimeSession RuntimeSession @relation(
    fields: [runtimeSessionId],
    references: [id],
    onDelete: Cascade
  )

  @@unique([runtimeSessionId, consumer])
}
```

Add the reverse optional `runtimeSession` relation to `AgentIssueRecord`.
`latestConfigOptions` stores the complete upstream list, including types and
current values. `latestUsage` stores the latest `used`, `size`, and optional
cost object. Do not store transcript content in these rows; transcript/event
history remains in acpx and the provider, with only projection checkpoints in
SQLite.

Session provisioning crosses SQLite and a provider process, so it cannot be a
single database transaction. Make it idempotent instead:

1. Upsert a `provisioning` row by deterministic `scopeKey` and commit it.
2. Call acpx `ensure` using that same scope.
3. Atomically attach the returned acpx IDs and mark the row `idle` or `active`.
4. On startup, reconcile unfinished `provisioning` rows by calling `ensure`
   again; never allocate a different scope merely because the prior process
   exited.

For migration, add these tables and relation first, then dual-write new
sessions while bb remains available. Existing `bbThreadId`, `lastBbEventSeq`,
and `BbEventCursor` fields remain readable during the transition. Do not invent
acpx/provider IDs for an existing bb thread: either create an explicitly new
acpx-backed continuation with a recorded provenance link, or leave that session
bb-backed until it is closed. Remove bb columns and cursors only after no live
session depends on them.

## ACP controls and Zed UX contract

The current adapter is not fully conformant with the controls Zed expects:

- reasoning effort is a `thought_level` select, but its ID currently changes
  with the selected model;
- speed is currently a `select`, so Zed renders a selector instead of a switch;
- boolean values are rejected by `setSessionConfigOption`;
- bb/acpx-originated config changes are not sent as `config_option_update`;
- bb usage events are not projected to ACP `usage_update`, so Zed has no values
  from which to display context percentage.

Map controls as follows:

| Setting | ACP shape | Zed behavior |
| --- | --- | --- |
| Agent/harness | Stable custom-category select, for example `_harness` | Generic selector; changing it may replace the upstream agent session while retaining the Remote Agent session |
| Model | Stable ID `model`, category `model`, select | Model picker and model keybindings |
| Permission mode | Stable ID `mode`, category `mode`, select | Mode picker; keep legacy ACP modes synchronized only while compatibility requires it |
| Reasoning effort | Stable ID `reasoning_effort`, category `thought_level`, select | Thinking-level picker and Zed thinking-effort actions |
| Fast mode | Stable ID `fast_mode`, category `model_config`, boolean | Zed switch/toggle; use a Standard/Fast select fallback only when the client did not advertise boolean config support |
| Context window | `session/update` with `sessionUpdate: "usage_update"`, numeric `used` and `size` | Zed computes and displays percentage; this is telemetry, not a config option |

Control-state rules:

1. Capture `clientCapabilities.session.configOptions.boolean` during
   `initialize`; never emit a boolean control unless advertised. Current Zed
   advertises this capability.
2. Keep config IDs stable for the lifetime of the logical session. Model
   changes may alter reasoning options and its current value, but not the
   reasoning control's ID.
3. Treat the upstream/acpx returned config list as canonical. Every
   `session/set_config_option` response must contain the complete list, including
   dependent changes and removed controls.
4. Forward every agent-initiated change as `config_option_update`, again with
   the complete list. Do not reconstruct it from an independently cached model,
   effort, or speed value.
5. Publish `usage_update` after new/load/resume once the session exists, after
   prompts when fresh values arrive, and when the effective context size
   changes. Send the raw token counts; Zed calculates the percentage.
6. On reconnect, restore the accepted model/config selections through acpx,
   return the restored complete config state in the setup response, and emit the
   latest usage only after Zed knows the session ID.

These rules follow the ACP session config option specification and completed
session-usage RFD. Zed's current ACP implementation advertises boolean config
support, replaces its local config list from set responses and
`config_option_update`, routes `thought_level` to its thinking controls, renders
boolean options as switches, and consumes `usage_update` into its context meter.

References:

- [ACP session config options](https://agentclientprotocol.com/protocol/v1/session-config-options)
- [ACP session context size and cost](https://agentclientprotocol.com/rfds/session-usage)
- [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup)
- [acpx sessions and recovery](https://acpx.sh/sessions.html)
- [acpx session control](https://acpx.sh/session-control.html)
- [Zed ACP server implementation](https://github.com/zed-industries/zed/blob/main/crates/agent_servers/src/acp.rs)
- [Zed config-option UI](https://github.com/zed-industries/zed/blob/main/crates/agent_ui/src/config_options.rs)

## Migration phases

### 1. Freeze the runtime contract — complete

- Replace bb-specific application types with a `SessionRuntime` port covering
  create/ensure, prompt/enqueue, cancel/close, status, event subscription,
  history, config mutation, and session metadata.
- Add the `RuntimeSession` and `RuntimeEventCursor` Prisma models, the optional
  `AgentIssueRecord` relation, and an additive SQLite migration. Implement the
  provisioning/reconciliation state machine before creating acpx sessions.
- Add repository methods that resolve sessions by stable ID, scope key, acpx
  IDs, and associated Linear issue. Keep cached config and usage updates atomic
  with their runtime-session mapping.
- Add contract tests around the behaviors currently hidden behind `BbClient`.
- Decide whether the first acpx release is local-only. If remote hosts remain a
  requirement, specify the SSH supervisor and path mapping before removing bb.

### 2. Add the acpx runtime adapter — complete

- Depend on the public `acpx/runtime` export rather than shelling out to the CLI.
- Persist acpx identity fields alongside each Remote Agent session.
- Translate structured ACP updates into the existing tracker projection input.
- Implement queue, cancel, close, crash recovery, and unattended permission
  policy.

### 3. Replace the Zed bridge with the combined ACP proxy — complete

- Make Zed session handlers call the same `SessionRuntime` used by webhook
  workers.
- Pass through upstream content, tool, permission, config, session-info, and
  usage updates with minimal transformation.
- Implement the control mapping and state rules above.
- Bind a reconnect to the persisted acpx mapping; do not create a session on
  transport establishment.

### 4. Move workers and projections — complete

- Migrate launches, Linear message forwarding, event ingestion, reflection,
  reconciliation, and termination from `BbClient` to `SessionRuntime`.
- Replace bb environment/host metadata with explicit execution-target and cwd
  records.
- Retain existing idempotency and projection-cursor guarantees.

### 5. Cut over and remove bb — complete

- Run bb and acpx adapters behind a temporary per-session runtime flag.
- Exercise real Codex and Claude sessions from both Linear and Zed, including
  active-turn enqueueing and process/SSH interruption.
- Migrate or deliberately close existing bb-backed sessions; transcript import
  does not imply provider-native resumability.
- Remove `bb-app`, `BbClient`, bb configuration, hidden execution-thread logic,
  and bb-specific health checks after the acpx path meets the acceptance suite.
- Supersede ADR 0001 with the final ownership decision.

## Acceptance suite

- Creating one Zed session creates exactly one Remote Agent/acpx logical mapping.
- A crash between the SQLite provisioning write and acpx attachment reconciles
  to the same scope and does not create a duplicate mapping.
- Disconnecting and reconnecting Zed over SSH does not create another mapping.
- Reconnect restores transcript, provider context, model, reasoning effort,
  permission mode, fast-mode state, and the latest context usage when the
  upstream agent supports them.
- Changing model returns a complete config list, updates dependent reasoning
  choices, and immediately updates the selector trigger.
- An upstream model fallback produces one complete `config_option_update` and
  Zed reflects it without another user action.
- Zed receives `fast_mode` as a boolean switch when it advertises support and a
  select fallback otherwise.
- Zed displays context usage from `usage_update`; a changed context limit updates
  the percentage without reopening the session.
- Prompts submitted from Linear during a Zed turn queue once and drain in order.
- Cancellation is cooperative and does not close or duplicate the session.
- A killed provider/queue-owner process resumes or loads the saved provider
  session; any fallback to a new provider session is observable.
- Tracker projection remains ordered and idempotent across process restarts.
- SQLite contains routing and checkpoints but no duplicate transcript; deleting
  cached config/usage does not prevent acpx/provider session recovery.

## Execution-target scope

acpx does not provide a fleet scheduler. Each Remote Agent deployment executes
agents locally for its configured repository/target; `hosts` remains routing
and Zed-link metadata. Multi-host installations run one deployment per target
against persistent local SQLite/acpx state.
