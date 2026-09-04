# Development

## Architecture ownership

- `RuntimeSession.id` is the stable ID exposed to Zed and integrations.
- acpx owns provider startup, ACP protocol handling, transcripts, and provider
  reconnect state.
- SQLite maps that stable ID to acpx and provider session IDs. Reconnecting
  Zed loads the same row instead of registering another logical session.
- Linear workers launch and route sessions through the application-owned
  `AgentSessionRuntime` interface. Linear issues are resources linked to
  sessions, not a shadow session registry.
- One machine daemon owns Prisma, acpx, and all configured repositories.
  Zed's ACP command is a stateless stdio bridge to that daemon.

## Running from a checkout

```sh
cp remote-agent.config.example.json remote-agent.config.json
bun install
bun run db:deploy
bun run start        # the daemon
```

The CLI is runnable in place with `bun run cli -- doctor` (any subcommand).
Set `REMOTE_AGENT_CONFIG` only when the config file lives somewhere else; it
is a file locator, not a second configuration surface.

## Desktop app

```sh
bun run desktop:dev
```

Renderer changes hot-reload; main-process changes require restarting the dev
app. Production bundles: `bun run desktop:dist` (signing is env-gated — see
the release workflow).

## Verification

```sh
bun run lint    # prisma generate + config schema + tsc
bun test
```

After changing the config schema in `src/lib/config.ts`, regenerate the JSON
schema with `bun run config:schema`.

## Layout notes

- `src/management/` — the platform layer shared by CLI and GUI: provisioning
  (`provision.ts`), self-updating deploy with rollback (`deploy.ts`), the
  doctor checklist (`checks.ts`), and the `supervisor/` seam (launchd on
  macOS, a Task Scheduler logon task on Windows). There are no shell scripts;
  everything is TypeScript under Bun.
- `bin/remote-agent` (and `.cmd`) — the CLI wrappers package managers put on
  PATH.
- `Formula/` and `bucket/` — this repo is its own Homebrew tap and Scoop
  bucket.

## Releases

Single cadence: tag `vX.Y.Z` and `.github/workflows/release.yml` runs tests,
creates the GitHub release (whose source tarball is what brew/scoop install),
builds the desktop artifacts for macOS and Windows, and commits the rendered
formula back to `main`. Signing (Apple Developer ID + notarization, Azure
Trusted Signing) activates automatically once the CI secrets exist; without
them the artifacts build unsigned.

Deployed installations update themselves from git via `remote-agent update`
(`src/management/deploy.ts`), independent of package-manager releases.

## Design history

The migration inventory and design decisions are recorded in
[docs/acpx-migration-plan.md](docs/acpx-migration-plan.md); the managed-
repository contract is in [docs/adoption.md](docs/adoption.md).
