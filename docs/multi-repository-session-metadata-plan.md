# Multi-repository session metadata plan

- Status: Executed
- Last reviewed: 2026-09-01
- Scope: make one Remote Agent deployment manage multiple repositories, make
  session metadata deterministic and configuration-owned, remove routing's
  dependency on the Linear Agent team, and establish one acpx runtime owner per
  machine.
- Builds on: [acpx migration plan](./acpx-migration-plan.md) and
  [ADR 0002](./adr/0002-acpx-runtime-ownership.md).

## Outcomes

After this work:

- one long-lived Remote Agent daemon owns acpx and SQLite on each machine;
- that daemon can run sessions for any repository declared in its JSON config;
- multiple named external-service connections can coexist, including multiple
  Linear workspaces;
- each session has stable machine, repository, harness, and role identity;
- each repository owns its custom tag definitions and selector options in JSON;
- SQLite stores custom tag keys and values only as strings;
- session creation applies metadata deterministically before acpx is invoked;
- later tag edits use the same validation path as session creation;
- routing queries the Remote Agent registry rather than using Linear Agent-team
  issues as the session registry; and
- Zed reconnects to the machine daemon without creating a second runtime owner
  or logical session.

This plan does not introduce a skill composer or skill hooks as an authority for
metadata. Skills may request ordinary tag mutations later, but they do not
define the vocabulary and never write SQLite directly.

## Decisions

### One runtime owner per machine

acpx is an embedded runtime library, not a repository-scoped daemon. A single
runtime accepts a different `cwd` for every session and can therefore serve
many repositories and worktrees.

The durable ownership unit is one Remote Agent daemon per machine:

```text
Zed stdio bridge ----\
HTTP and webhooks ----> Remote Agent machine daemon
CLI and integrations -/        |-- one acpx runtime
                                |-- one acpx state directory
                                |-- one SQLite owner
                                `-- many repositories and sessions
```

The current implementation creates an `AcpxSessionRuntime` in both
`src/server.ts` and `src/acp/main.ts`. That is an interim defect in the ownership
model. The daemon must become the only process that instantiates acpx and
Prisma. The Zed entrypoint remains necessary as an ACP stdio transport, but it
becomes a stateless bridge to the daemon over a local IPC endpoint. When Zed is
connected through SSH, the remotely launched bridge connects to the daemon on
that same remote machine.

Only one daemon may own a configured `(databaseUrl, acpx.stateDir)` pair. A
second daemon must fail fast rather than concurrently opening the same acpx
state.

### Each repository owns its tag vocabulary

Custom tag definitions live under the owning repository in
`remote-agent.config.json`. SQLite does not contain tag-definition, enum-option,
or tag-type tables. There is no machine-wide global tag vocabulary that every
repository must adopt.

A definition controls:

- its stable key;
- an optional human-readable description;
- optional allowed string values used for validation and UI selectors;
- whether a session may have one or many values; and
- whether the router may see the tag.

The pair `(repositoryId, key)` is a definition's identity. Two repositories may
use different keys or give the same key different options and meaning. Renaming
a key within a repository creates a new tag unless an explicit data migration
is performed.

### Custom tags are opaque strings in SQLite

Both tag keys and values are stored as strings. There are no database-level
boolean, enum, numeric, JSON-value, or foreign-key variants. For example, a
boolean-like tag uses the strings `"true"` and `"false"`, with those options
declared in JSON.

An absent `options` list means any nonempty string is assignable. Options limit
new assignments and drive selectors; they are not a database enum. If an option
is removed from config, an existing value remains readable and removable but
cannot be newly assigned.

### Identity and relationships are not custom tags

The following remain first-class session fields because routing and lifecycle
integrity depend on them:

- machine ID;
- repository ID;
- harness/agent command;
- role; and
- runtime status and provider/acpx identity mappings.

Session-to-session relationships are first-class edges, not encoded tag values.
Examples include `spawned-by`, `delegates-to`, `handoff-to`, and `replaces`.
The relationship type is a string so new relationship semantics do not require
a database migration.

External resources such as a Linear issue or GitHub pull request are also
generic links, not tags or Linear-specific columns on the session. Their
provider, connection ID, resource type, external ID, and relationship are
stored as strings.

### Connections are reusable; each server webhook owns its routing

Connections are named outbound API identities. Webhooks are named inbound
server inputs that reference a connection. Each webhook contains its own
repository routing map. The keys of that map are both the webhook's repository
allowlist and the possible routing targets.

The config schema is provider-discriminated so it can eventually contain
Linear, Slack, GitHub, or other connection kinds. The first implementation only
supports `provider: "linear"`; unsupported providers fail config validation
until their adapters exist. Multiple independently authenticated Linear
connections are supported from the first version.

Webhook definitions do not live inside repositories and there is no separate
global routing-rules list that can drift from a webhook's authorization scope.
They live under `server.webhooks`, because they are inbound server endpoints.

## Target JSON shape

The singular `repository` object becomes a `repositories` map keyed by stable
repository ID. The ID must be consistent across machines even when local paths
differ.

All metadata keys and values in this document are examples only. Remote Agent
does not prescribe or automatically create `example.workflow`,
`example.accepts-input`, `example.specialization`, or any other custom tag.
Each repository supplies only the definitions useful to its own workflow.

```json
{
  "serviceName": "remote-agent",
  "server": {
    "publicUrl": "https://agents.example.com",
    "apiKey": "replace-with-a-long-random-api-key",
    "host": "127.0.0.1",
    "port": 9000,
    "databaseUrl": "file:./remote-agent.sqlite",
    "ipcPath": "~/Library/Application Support/remote-agent/daemon.sock",
    "githubWebhookSecret": "replace-with-github-webhook-secret",
    "webhooks": {
      "linear-product": {
        "connection": "linear-main",
        "webhookSecret": "replace-with-linear-webhook-secret",
        "repositoryRouting": {
          "remote-agent": {
            "when": [
              {
                "linear.teamId": ["replace-with-linear-team-id"],
                "linear.projectId": ["replace-with-linear-project-id"]
              }
            ]
          }
        }
      }
    }
  },
  "acpx": {
    "stateDir": "~/Library/Application Support/remote-agent/acpx",
    "permissionMode": "approve-all",
    "nonInteractivePermissions": "deny",
    "agents": {}
  },
  "connections": {
    "linear-main": {
      "provider": "linear",
      "apiKey": "replace-with-linear-api-key",
      "agentUserId": "replace-with-linear-agent-user-id",
      "agentHandle": "agent"
    },
    "linear-second-workspace": {
      "provider": "linear",
      "apiKey": "replace-with-another-linear-api-key",
      "agentUserId": "replace-with-another-linear-agent-user-id"
    }
  },
  "runtime": {
    "machine": "studio-mac"
  },
  "hosts": [
    {
      "id": "studio-mac",
      "label": "Studio Mac",
      "zedConnection": "local",
      "acceptsTrackerInput": true,
      "default": true
    }
  ],
  "repositories": {
    "remote-agent": {
      "root": "~/checkouts/remote-agent",
      "worktreeRoot": "../.worktrees/remote-agent",
      "bootstrapCommand": ["bun", "install"],
      "metadata": {
        "tags": {
          "example.workflow": {
            "description": "Example workflow classification",
            "options": ["planning", "implementation", "review"],
            "cardinality": "one",
            "routerVisible": true
          },
          "example.accepts-input": {
            "options": ["true", "false"],
            "cardinality": "one",
            "routerVisible": true
          },
          "example.specialization": {
            "cardinality": "many",
            "routerVisible": true
          }
        }
      },
      "sessionDefaults": {
        "tags": {
          "example.accepts-input": ["true"],
          "example.specialization": ["typescript", "agent-runtime"]
        }
      },
      "workflows": {
        "describe": {
          "prompt": "prompts/describe-issue.md",
          "harness": "claude",
          "model": "opus"
        },
        "orchestrate": {
          "prompt": "prompts/orchestrate-plan.md",
          "harness": "codex"
        },
        "reflect": {
          "prompt": "prompts/reflect.md"
        }
      }
    }
  }
}
```

Tag defaults always use arrays, including single-cardinality tags. This gives
the parser one representation and makes cardinality validation explicit.

Repository-specific config contains paths, bootstrap behavior, workflows, tag
definitions, and default tag values. Connections and server webhook routing
remain outside repositories. A tag definition applies only to sessions
whose `repositoryId` identifies that repository. The UI and mutation service
always resolve options through the session's repository before displaying or
validating a value.

## Connection-aware webhook routing

Each webhook is exposed at a stable named path such as
`/webhooks/linear-product`. The handler loads `server.webhooks.linear-product`,
resolves its connection, verifies the request with its own secret, and uses
that connection for any provider API reads needed to enrich the event.

The provider adapter normalizes routing attributes as strings. Linear initially
provides attributes such as `linear.organizationId`, `linear.teamId`, and
`linear.projectId`. Each `repositoryRouting` key names one allowed repository.
Its optional `when` array contains alternative match objects with these
semantics:

- objects within a `when` array are OR alternatives;
- keys within one object are AND conditions;
- values for a key are OR choices;
- a result is valid only when exactly one distinct repository matches;
- omitting `when` makes that repository an unconditional target; and
- an unconditional target is valid only when it is the webhook's sole routing
  target. Otherwise config validation rejects the ambiguity.

Repository selection never uses a model. It completes before workflows,
session metadata, or session routing are evaluated.

## Repository resolution

Every session has a stable `repositoryId`; `cwd` alone is not identity.

The config loader and repository resolver:

1. expands and normalizes every repository and worktree path;
2. uses the most-specific matching root and rejects an equal ambiguous match;
3. validates prompt paths and defaults against that repository's metadata
   definitions;
4. verifies that single-cardinality defaults contain at most one value; and
5. produces lookup indexes for roots and managed worktree roots.

At session creation, the caller may provide a repository ID explicitly. If it
does not, Remote Agent resolves the supplied `cwd` using the configured checkout
and worktree roots. The most-specific path match wins, but startup rejects
configurations in which that rule cannot resolve deterministically. A `cwd`
that belongs to no configured repository is rejected rather than silently
assigned to a default repository.

Zed `session/new` resolves its `cwd` through this same path. Session listing is
restricted to the resolved repository and can prefer the exact worktree; load
and resume continue to use the stable Remote Agent session ID.

## SQLite target shape

Add stable identity fields to `RuntimeSession`:

```prisma
model RuntimeSession {
  id             String @id @default(cuid())
  repositoryId   String
  machineId      String
  agentCommand   String
  role           String?
  cwd            String
  // Existing acpx/provider identity and lifecycle fields remain.

  tags           RuntimeSessionTag[]
  outgoing       RuntimeSessionRelation[] @relation("relation-source")
  incoming       RuntimeSessionRelation[] @relation("relation-target")
  resourceLinks  RuntimeSessionResourceLink[]

  @@index([repositoryId, status])
  @@index([machineId, status])
}
```

Store custom tags without database typing:

```prisma
model RuntimeSessionTag {
  id               String   @id @default(cuid())
  runtimeSessionId String
  key              String
  value            String
  source           String
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  runtimeSession RuntimeSession @relation(
    fields: [runtimeSessionId],
    references: [id],
    onDelete: Cascade
  )

  @@unique([runtimeSessionId, key, value])
  @@index([key, value])
}
```

Store session relationships as flexible string-labelled edges:

```prisma
model RuntimeSessionRelation {
  id              String   @id @default(cuid())
  sourceSessionId String
  targetSessionId String
  relationship    String
  createdAt       DateTime @default(now())
  endedAt         DateTime?

  source RuntimeSession @relation(
    "relation-source",
    fields: [sourceSessionId],
    references: [id],
    onDelete: Cascade
  )
  target RuntimeSession @relation(
    "relation-target",
    fields: [targetSessionId],
    references: [id],
    onDelete: Cascade
  )

  @@unique([sourceSessionId, targetSessionId, relationship])
  @@index([targetSessionId, relationship])
}
```

Store integration links generically:

```prisma
model RuntimeSessionResourceLink {
  id               String   @id @default(cuid())
  runtimeSessionId String
  provider         String
  connectionId     String
  resourceType     String
  externalId       String
  relationship     String
  createdAt        DateTime @default(now())
  endedAt          DateTime?

  runtimeSession RuntimeSession @relation(
    fields: [runtimeSessionId],
    references: [id],
    onDelete: Cascade
  )

  @@unique([
    runtimeSessionId,
    provider,
    connectionId,
    resourceType,
    externalId,
    relationship
  ])
  @@index([provider, connectionId, resourceType, externalId])
}
```

`source` and `relationship` are deliberately strings. Their application-level
values are validated where policy requires it, but adding a new integration or
mutation source does not require a schema migration.

## Deterministic session instantiation

All creation paths—Zed, workflow workers, HTTP launches, integrations, and
future CLI commands—call one provisioning operation. Conceptually:

```ts
ensureSession({
  sessionKey,
  repositoryId: "remote-agent",
  machineId: "studio-mac",
  agent: "codex",
  role: "primary",
  cwd,
  tags: {
    "example.workflow": ["implementation"]
  },
  relations: [
    { relationship: "spawned-by", targetSessionId: parentId }
  ],
  resourceLinks: [
    {
      provider: "linear",
      connectionId: "linear-main",
      resourceType: "issue",
      externalId: issueId,
      relationship: "handles"
    }
  ]
});
```

The service resolves metadata in this order:

1. system-owned machine, repository, harness, and role values;
2. repository `sessionDefaults.tags`;
3. workflow/profile-provided values, when applicable; and
4. explicit values supplied by the creation request.

Later layers replace an earlier value for a single-cardinality tag and union
values for a many-cardinality tag. The fully resolved result is validated
against the JSON definitions belonging to the selected repository.

In one SQLite transaction, Remote Agent writes or verifies the provisioning
session row, its resolved tags, relationships, and resource links. Only after
that transaction commits does it call acpx `ensureSession`. Existing
provisioning recovery remains idempotent by `scopeKey`. Retrying the same
creation contract verifies the stored metadata rather than silently changing
it.

Runtime status, usage, transcript, and provider configuration are not tags.
They continue to come from acpx/provider events and the existing lifecycle
projection.

## Tag editing and config changes

One metadata service handles both initial assignment and later edits. It:

- rejects unknown keys;
- rejects empty keys and values;
- checks configured options when present;
- enforces configured cardinality;
- records the mutation source;
- updates a single-cardinality value atomically; and
- emits an auditable metadata-change event.

The first operator surface is an authenticated HTTP API. A small CLI may call
it later. Zed controls may also be added for selected tags, but custom
tags must not be confused with upstream ACP model, mode, thought-level, or fast
mode controls.

Config is authoritative for definitions. Startup validates every repository's
complete definition set. It never rewrites stored tags merely because an
option was removed. Unknown historical values are returned with an `unlisted`
indication by the API and cannot be assigned again.

Session creation stores a hash of the complete creation metadata to detect a
conflicting retry. Metadata mutations are recorded as audit events; definitions
themselves are not copied into database tables.

## Routing without the Linear Agent team

Preserve the current router's useful two-stage pattern while changing its data
source:

1. Resolve the source resource link, including its connection ID, and
   repository.
2. Query `RuntimeSession`, tags, relationships, and resource links in SQLite.
3. Apply deterministic eligibility gates using runtime status, machine,
   repository, role, configured machine policy, and live acpx state.
4. Select the only eligible session directly when exactly one remains.
5. When several remain, give the semantic selector only router-visible tags,
   session relationships, and source/workflow context.
6. Re-fetch and postvalidate the selected session before enqueueing.

Linear remains an input and projection integration, but Linear Agent-team
issues, labels, states, and assignees cease to be the session registry. All
Linear reads and writes use the connection recorded on the source resource
link. The hardcoded machine exception in the selection skill is removed;
machine acceptance policy comes from config and registry state.

Provider-native subagents remain internal to their parent provider session.
Only a subagent deliberately promoted into a `RuntimeSession` receives tags,
relationships, independent routing, and Zed session selection.

## Implementation phases

The phases below are complete in the repository. The old Linear session-event
endpoint is no longer mounted, and production routing does not read the legacy
Agent-team projection. Historical projection code and tables remain only so
existing migrations and old databases stay understandable; they are not a
runtime dependency.

### 1. Lock contracts and migration fixtures

- Add config fixtures for two repositories with different tag definitions and
  options, two Linear connections, independently scoped webhooks, repository
  defaults, worktrees, and ambiguous-path failures.
- Add runtime contract tests for deterministic metadata resolution and retries.
- Add a process-ownership test proving that the Zed entrypoint does not create
  acpx or Prisma owners.
- Capture current Linear routing behavior as tests before replacing its registry
  source.

### 2. Introduce the multi-repository config

- Replace `repository` with `repositories` and add stable repository lookup.
- Retain the existing `runtime.machine` plus `hosts` execution-target shape;
  make repository selection independent of that machine-local path config.
- Add the per-repository string-tag definition schema and repository defaults.
- Add named provider-discriminated connections and named
  `server.webhooks` entries whose `repositoryRouting` keys form their allowlist.
  Implement only the Linear connection adapter in this phase.
- Refactor workflows, worktree provisioning, routes, and tests to accept a
  resolved `RepositoryConfig` instead of reading one global repository.
- Update `remote-agent.config.example.json`, README, and adoption documentation.

This is a deliberate config-format break. Because the project is still early,
do not retain two permanent config shapes. Provide a concise migration error
when singular `repository` is encountered.

### 3. Add the generic session metadata registry

- Add `repositoryId`, `machineId`, and `role` to `RuntimeSession`.
- Add string-only tag, session-relation, and resource-link tables.
- Backfill existing sessions by matching their normalized `cwd` to configured
  repository roots. Abort deployment with a report if any active row is
  ambiguous or unmatched.
- Add indexed registry queries and a single metadata validation/mutation
  service.
- Add metadata mutation audit events without storing config definitions in
  SQLite.

### 4. Make instantiation authoritative

- Extend `EnsureAgentSessionInput` with repository, role, tags, relationships,
  and resource links.
- Resolve defaults and explicit values once, before session creation.
- Persist the complete identity and metadata assignment transactionally before
  calling acpx.
- Make retries verify the same creation intent and surface conflicts.
- Route every session creation path through this operation.

### 5. Enforce one acpx owner per machine

- Move all runtime and Prisma ownership into the long-lived machine daemon.
- Add a local authenticated IPC API for ACP operations and event streaming.
- Convert `src/acp/main.ts` into a stateless ACP stdio-to-daemon bridge.
- Add daemon ownership locking for the database/state pair and graceful stale
  lock recovery.
- Verify daemon restart, Zed stdio restart, SSH disconnect/reconnect, active-turn
  recovery, and parallel sessions across repositories.

### 6. Move routing off the Linear Agent team

- Replace Agent-team candidate discovery with SQLite registry queries.
- Preserve deterministic eligibility, semantic tie-breaking, and postvalidation.
- Use connection-aware generic resource links to associate source issues with
  sessions.
- Remove Agent-team labels, lifecycle-state mirroring, and team-key config once
  no route reads them.
- Keep only the Linear user identity, webhook, comment, and source-issue settings
  required by the integration.

### 7. Add runtime editing surfaces

- Add authenticated list/set/remove tag endpoints with optimistic concurrency.
- Return configured options and flag stored values that are no longer listed.
- Add relationship and resource-link inspection; initially restrict relationship
  mutation to trusted launch/integration paths.

### 8. Cut over and clean up

- Apply the committed Prisma migration during deployment and migrate the real
  JSON file from `repository` to `repositories` before restart.
- Exercise Zed, Linear, HTTP launch, and termination paths for every configured
  repository in deployment smoke tests.
- Remove the production Agent-team routes and configuration. Retain only
  isolated historical migration/projection code until old schema support can be
  dropped safely.
- Update ADR 0002 to record the daemon/bridge process boundary and add a separate
  ADR for metadata authority and string-only tag storage.

## Acceptance criteria

- One daemon on a machine serves simultaneous sessions in at least two
  configured repositories.
- Two Linear connections can ingest events and perform outbound operations
  without sharing credentials, webhook secrets, receipts, or resource links.
- A webhook can route only to its configured allowed repositories, and an
  ambiguous repository match fails closed.
- Starting the HTTP service and any number of Zed bridges creates exactly one
  acpx runtime owner and one SQLite owner.
- A Zed/SSH disconnect and reconnect restores the same stable session without a
  duplicate runtime row or acpx mapping.
- Repository resolution is deterministic for roots and managed worktrees and
  rejects unknown or ambiguous paths.
- Session creation writes repository, machine, harness, role, tags,
  relationships, and resource links before acpx is invoked.
- Retrying creation with the same scope is idempotent; conflicting identity or
  metadata fails visibly.
- SQLite stores every custom tag key and value as a string and contains no tag
  definition or option table.
- Tag options and cardinality are resolved from the session's repository; one
  repository's definitions never affect another repository's sessions.
- Single- and many-cardinality behavior is enforced from JSON.
- Removing a configured option does not delete historical tag values, and the
  removed value cannot be newly assigned.
- Router candidate discovery succeeds without querying Linear Agent-team issues
  or labels.
- Semantic routing receives only tags marked `routerVisible` by the owning
  repository.
- An explicit tag edit is validated, atomic, attributable, and auditable.
- Provider model/config controls, usage, transcript, and lifecycle state remain
  separate from custom tags.

## Delivery boundary

Phases 1 through 5 establish the reusable multi-repository runtime and metadata
foundation. Phase 6 removes the Linear Agent-team dependency. Phases 7 and 8
complete operational editing and cleanup. Do not remove the old routing source
until registry-backed routing passes the same selection and postvalidation
tests.
