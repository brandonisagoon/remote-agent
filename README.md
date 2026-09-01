# Remote Agent

Remote Agent turns Linear collaboration and Zed ACP conversations into durable
coding-agent sessions. It uses [acpx](https://acpx.sh/) for ACP/provider
execution and extends the existing Prisma/SQLite database with stable runtime
identity, Linear ownership, cached controls/usage, and independent projection
cursors.

## What it owns

- `RuntimeSession.id` is the stable ID exposed to Zed and Linear.
- acpx owns provider startup, ACP protocol handling, transcripts, and provider
  reconnect state.
- SQLite maps that stable ID to acpx and provider session IDs. Reconnecting Zed
  loads the same row instead of registering another logical session.
- Linear workers launch, route, end, and reconcile sessions through the
  application-owned `AgentSessionRuntime` interface.
- Low-volume acpx turn lifecycle events update Linear. Token, thought, and tool
  deltas remain in ACP/the transcript and do not consume Linear API quota.

## Requirements

- Bun 1.3.14+
- Codex and/or Claude agent commands supported by acpx
- Linear and GitHub webhook credentials
- a checkout of the repository this service will operate on

## Setup

```sh
cp remote-agent.config.example.json remote-agent.config.json
bun install
bun run db:deploy
bun run start
```

`remote-agent.config.json` is intentionally gitignored. All service settings,
including credentials and acpx command overrides, live in that one JSON file.
Set `REMOTE_AGENT_CONFIG` only when the file lives somewhere else; it is a file
locator, not a second configuration surface.

Run the Zed ACP stdio endpoint with:

```sh
bun run acp
```

The endpoint is the Zed-facing ACP adapter and acpx is its runtime backbone.
Zed receives stable controls for harness, model, mode, thinking level, and fast
mode. Fast mode is exposed as a boolean when the client advertises boolean
config support, while context usage is restored with `usage_update` after load
or resume.

## Repository integration

Remote Agent is configured once per managed repository:

- `repository.root` points at its main checkout.
- `repository.worktreeRoot` selects where managed worktrees are created.
- `repository.bootstrapCommand` prepares each new worktree.
- workflow prompt paths are relative to `repository.root`.
- `hosts` describe execution-target labels and how Zed should open a worktree.

The managed repository supplies the bootstrap script and prompt files; it does
not import this package or maintain a second environment file. See
[docs/adoption.md](docs/adoption.md) for the exact contract and
[remote-agent.config.example.json](remote-agent.config.example.json) for every
setting.

## Persistence and reconnects

The configured service database contains webhook receipts, worker runs,
`AgentIssueRecord`, `RuntimeSession`, and `RuntimeEventCursor`. acpx stores its
own transcript/runtime records under `acpx.stateDir`. Both paths must be on
persistent storage.

An SSH transport disconnect does not close a runtime session. Zed can call
`session/resume` or `session/load` with the same Remote Agent session ID; the
adapter reattaches acpx/provider state and returns the latest complete control
state and context usage. Explicit close/end operations are what mark a session
closed.

## Verification

```sh
bun run lint
bun test
```

The detailed migration inventory and design decisions are recorded in
[docs/acpx-migration-plan.md](docs/acpx-migration-plan.md).
