# ADR 0001: Runtime, session ownership, and distribution

- Status: Accepted
- Date: 2026-08-18
- Decision owners: Remote Agent maintainers

## Context

Remote Agent turns issue-tracker collaboration into durable coding-agent work.
The extracted service must remain usable outside the Cubic monorepo while
preserving durable and resumable threads, an ordered event log, explicit host
and workspace placement, safe delivery during active turns, provider choice,
and an independently supervised headless API.

The code dependency on bb is narrow. The concrete adapter under
`src/lib/transports/bb/` imports `bb-app`; workers and services depend on the
application-owned `BbClient` interface. The conceptual dependency is wider:
bb owns the canonical transcript, sequenced thread events, execution hosts,
provider sessions, pending interactions, and thread lifecycle. Remote Agent's
SQLite data is a routing index and replay cursor, not a replacement session
store.

## Decision

Remote Agent will consume a separately running bb server through the official
`bb-app` SDK. The `BbClient` interface remains the application-owned port.
bb is the source of truth for transcripts, ordered events, host placement,
provider runtime, interactions, and lifecycle. Remote Agent is the source of
truth for tracker integration, webhook receipts, projection cursors, routing
metadata, and workflow policy.

We will not remove or fork bb. Removing it would require this service to own
provider processes, durable sessions, event ordering, multi-host placement,
reconnect/replay, queueing, and lifecycle recovery. A fork would add permanent
upstream maintenance without providing a capability missing from the public
SDK.

The initial product will remain a standalone service rather than a bb plugin.
Webhook ingress, tracker access, SQLite migrations, deployment polling, and the
ACP bridge need an independently observable and restartable lifecycle. A thin
plugin may later provide installation, health, configuration, and open-thread
conveniences, but it must not become another source of truth.

Initial distribution is a standalone Git repository with tagged releases,
Bun as the supported runtime, `bun install`, and a parameterized installer.
npm publication, Homebrew, and compiled binaries are deferred until the
service contract stabilizes.

## Session-runtime survey

A replacement must own durable threads, a replayable ordered event stream,
host/workspace placement, and defined active-turn delivery semantics.

| Candidate | Finding |
| --- | --- |
| bb | Selected. It satisfies durable threads, ordered events, enrolled hosts, and queue/steer delivery. |
| T3 Code | A close architectural peer, but its durable event projections and workers are part of another complete UI/server orchestration stack. |
| OpenCode server | Offers session APIs and SSE, but not a documented provider-neutral fleet or queue-if-active ownership contract. |
| GitHub Copilot SDK | Offers persistent sessions and enqueue/steer modes, but is provider-specific and leaves concurrency serialization to the application. |
| OpenClaw Gateway | Owns sessions and queue modes, but is an omnichannel personal-agent control plane rather than a coding-worktree runtime. |
| Claude Code CLI | Resumes provider-local sessions but is not a shared event store or host registry. |
| Agent Client Protocol | Standardizes session interoperability; it is a protocol, not a persistence or execution implementation. |

Sources: [T3 Code architecture](https://github.com/pingdotgg/t3code/blob/main/docs/architecture/overview.md),
[OpenCode server API](https://dev.opencode.ai/docs/server/),
[Copilot session persistence](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/session-persistence),
[Copilot steering and queueing](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/steering-and-queueing),
[OpenClaw sessions](https://github.com/openclaw/openclaw/blob/main/docs/concepts/session.md),
[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/cli-usage), and
[ACP session resume](https://agentclientprotocol.com/announcements/session-resume-stabilized).

## Consequences

The extraction can preserve a working runtime, isolate SDK churn behind
`BbClient`, and evolve tracker, host, and repository contracts independently.
Adopters must operate both bb and Remote Agent, compatibility must be tested
against supported bb versions, and bb's network boundary remains a deployment
concern.

Mitigations include pinning a compatible SDK range, contract-testing the bb
adapter, advancing event cursors only after successful projection, retaining
queue-if-active delivery, exposing dependency-specific health, and using one
validated service configuration.

After a stable standalone release, reevaluate a thin bb plugin only if it can
supervise the external service on headless installations without owning its
database or weakening the public HTTP and `BbClient` boundaries.
