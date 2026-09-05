<!-- SYNC NOTE: CLAUDE.md (read by Claude Code) and AGENTS.md (read by Codex) are manually maintained mirrors.
     When editing either file, apply the same change to the other. -->

# Remote Agent

Control plane that turns Linear activity into durable coding-agent sessions,
executed by acpx (Codex / Claude Code) in isolated git worktrees. One repo,
three artifacts on a single release cadence: the CLI (`src/cli/`), the daemon
(`src/server.ts`), and the Electron desktop app (`src/desktop/`). This repo is
its own Homebrew tap (`Formula/`) and Scoop bucket (`bucket/`).

## Architecture

- **Daemon** (Hono + Bun, port from config) — webhooks, session router,
  workflow engine, acpx sessions, own Prisma/SQLite store. Reads config once
  at boot; runs from the deployed copy under the install root, supervised by
  launchd (macOS) / a Task Scheduler logon task (Windows).
- **Desktop app** (electron-vite + React + Tailwind v4 + vanilla shadcn) — a
  pure control plane editing the config JSON. TanStack Router (hash history,
  code-based routes in `src/desktop/renderer/src/router.tsx`) + TanStack
  Query (`lib/queries/`; NO TanStack DB). Saves are explicit: draft state
  over the `['config']` query, sonner save/revert — never save per keystroke.
- **CLI** (`remote-agent`) — thin commander skin over `src/management/`.
- **`src/management/`** — the platform layer shared by CLI and GUI:
  provisioning, self-updating deploy with rollback, the doctor checklist
  (`checks.ts` — single source for CLI doctor AND the GUI status tables), and
  the `supervisor/` seam. **No shell scripts** — everything is TypeScript.
- **`src/lib/skills/`** — skill-composer boundary. Repos own skill-composer
  as their own dev dependency; we always **exec** their copy (or a bun child
  process for the inventory shim), never import repo-owned config in-process.
- **Thread registry** (`src/lib/services/sessions/threads.ts`) — conversation
  threads live in `RuntimeSessionResourceLink` (`comment-thread`, relationship
  `thread`/`question`): registered threads deliver without a mention or a
  router call; `question` threads frame the next human reply as the answer.
- **Plan capture** (`src/lib/services/sessions/plan-capture.ts`) — a
  workflow with `plan: { captureToIssue, thenState? }` launches its session
  in plan mode (`RuntimeSession.workflowId` records provenance); the acpx
  `onPermissionRequest` hook intercepts the exit-plan-mode approval (tool
  kind `switch_mode` + `rawInput.plan`), writes the plan into the source
  issue's `## Implementation Plan` section (spliced in place), transitions
  the issue to `thenState` only after the write succeeds, then defers to
  approve-all. Failures log and defer — never block the turn. Claude only.
- **Workflows** (`repositories.<id>.workflows`) — trigger (`on` +
  `when` conditions + optional `connectionId`) → skill (skillset + flags) →
  delivery (`start-session` | `message-session`). Matched in the webhook
  handlers (`src/lib/workflows/match.ts`), executed by the single workflow
  worker (`src/lib/workers/product/workflow/`), which composes
  `{{SKILL:skillset+flags}}` tokens via `composeForPrompt` inside the
  session's worktree.

## Vocabulary (enforced across JSON, code, and UI)

- **provider** (codex | claude) — never "harness" (except skill-composer's own
  `harnesses` API).
- **label groups / labels** — `repositories.<id>.labels` +
  `sessionDefaults.labels`; `exclusive` (not cardinality), `routerVisible`.
  The Prisma `tags` rows are the one storage-internal exception, mapped to
  `labels` at every seam.
- **connection** owns machineId, repository allowlist, one webhook, router,
  editors. **machine** is physical (server, sockets, sshHost, installation).
- IDs are opaque (`wh-xxxx`, `repo-xxxx`); fields referencing them end in
  `Id`; maps are keyed by ID.

## Conventions

- Kebab-case file names. Explicit named exports in barrels, no `export *`.
- Zod v4 schemas in `src/lib/config.ts` are the single config source; the UI
  mirrors the JSON shape exactly — when one changes, both change.
- Share libraries within TypeScript; **exec across real boundaries** (repo
  scripts, skill-composer, launchctl/schtasks, cloudflared).
- The GUI never does privileged or account-bound work: buttons open Terminal
  with a prefilled command (`openInTerminal`) — the sudo/brew/cloudflared
  runs in the user's own shell.
- UI patterns: settings pages are accordions of `SettingsSection` +
  `SettingsCard`; tables use `-mx-4` bleed, fixed column widths, h-14 rows,
  hover-revealed row actions, status = `StatusDot`, adds via a macOS System
  Settings-style footer bar (+). Page-specific components colocate under
  `pages/<page>/`.

## Working on this repo

- **Restart matrix**: renderer (`src/desktop/renderer/`) hot-reloads;
  `src/desktop/main/`, `src/lib/`, `src/management/` need a full
  `bun run desktop:dev` restart; daemon changes need a daemon restart.
  Never kill the user's running dev app — tell them what needs restarting.
- **TWO live configs on the dev machine**: the daemon's
  `~/Library/Application Support/remote-agent/remote-agent.config.json` AND
  the dev desktop app's userData copy at
  `~/Library/Application Support/Remote Agent/remote-agent.config.json`.
  Every schema migration must be applied to both (plus
  `remote-agent.config.example.json`), and the regenerated schema
  (`bun run config:schema`) copied next to both.
- **Verification loop**: `bunx tsc --noEmit && bun test && bun run
  desktop:build`. CLI tsc is authoritative; editor diagnostics are often
  stale.
- **Test seams**: `test-support/fake-acpx.ts` (+ `withAcpxCli`) for the
  router, `test-support/fake-skill-composer.ts` via
  `REMOTE_AGENT_SKILL_COMPOSER` for composition, `test-support/config.ts`
  for resolved-config fixtures. Contract tests in `test/contracts/` pin
  deploy/skills invariants.
- Import cycles: webhook handlers import the dispatcher, which loads the
  worker registry **lazily** — don't add static imports from workers back
  into broad service barrels without checking the cycle.
