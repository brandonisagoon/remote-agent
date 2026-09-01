# Remote Agent

Remote Agent turns Linear collaboration and Zed ACP conversations into durable
coding-agent sessions. It uses [acpx](https://acpx.sh/) for ACP/provider
execution and extends the existing Prisma/SQLite database with stable runtime
identity, repository-scoped string metadata, cached controls/usage, and
independent projection cursors.

## What it owns

- `RuntimeSession.id` is the stable ID exposed to Zed and integrations.
- acpx owns provider startup, ACP protocol handling, transcripts, and provider
  reconnect state.
- SQLite maps that stable ID to acpx and provider session IDs. Reconnecting Zed
  loads the same row instead of registering another logical session.
- Linear workers launch and route sessions through the application-owned
  `AgentSessionRuntime` interface. Linear issues are resources linked to
  sessions, not a shadow session registry.
- One machine daemon owns Prisma, acpx, and all configured repositories. Zed's
  ACP command is a stateless stdio bridge to that daemon.

## Requirements

- Bun 1.3.14+
- Codex and/or Claude agent commands supported by acpx
- Linear and GitHub webhook credentials
- checkouts of the repositories this service will operate on

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

The command is the Zed-facing ACP adapter; the machine daemon must already be
running. The bridge connects to `server.ipcPath` and never opens SQLite or acpx.
Zed receives stable controls for harness, model, mode, thinking level, and fast
mode. Fast mode is exposed as a boolean when the client advertises boolean
config support, while context usage is restored with `usage_update` after load
or resume.

## Repository integration

One machine config can declare several managed repositories:

- `repositories.<id>.root` points at a main checkout.
- `repositories.<id>.worktreeRoot` selects where managed worktrees are created.
- `repositories.<id>.bootstrapCommand` prepares each new worktree.
- workflow prompt paths and custom metadata definitions are repository-scoped.
- `connections.<id>` defines a reusable Linear identity.
- `server.webhooks.<id>` selects a connection and embeds its own
  `repositoryRouting` allowlist/rules.
- `hosts` describe execution-target labels and how Zed should open a worktree.

The managed repository supplies the bootstrap script and prompt files; it does
not import this package or maintain a second environment file. See
[docs/adoption.md](docs/adoption.md) for the exact contract and
[remote-agent.config.example.json](remote-agent.config.example.json) for every
setting.

## Persistence and reconnects

The configured service database contains webhook receipts, worker runs,
`RuntimeSession`, string tags, session relationships, resource links, and
consumer cursors. acpx stores its own transcript/runtime records under
`acpx.stateDir`. Both paths must be on persistent storage.

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
