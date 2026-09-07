<!-- SYNC NOTE: CLAUDE.md (read by Claude Code) and AGENTS.md (read by Codex) are manually maintained mirrors.
     When editing either file, apply the same change to the other. -->

# Remote Agent

Control plane that turns Linear activity into durable coding-agent sessions,
executed by acpx (Codex / Claude Code) in isolated git worktrees. One repo,
three artifacts on a single release cadence: the CLI (`apps/cli/`), the server
(`apps/server/server.ts`), and the Electron desktop app (`apps/desktop/`). This repo is
its own Homebrew tap (`Formula/`) and Scoop bucket (`bucket/`).

## Architecture

- **Server** (Hono + Bun, port from config) — webhooks, session router,
  workflow engine, acpx sessions, own Prisma/SQLite store. Reads config once
  at boot; runs from the deployed copy under the install root, supervised by
  launchd (macOS) / a Task Scheduler logon task (Windows).
- **Desktop app** (electron-vite + React + Tailwind v4 + vanilla shadcn) — a
  pure control plane editing the config JSON. TanStack Router (hash history,
  code-based routes in `apps/desktop/renderer/src/router.tsx`) + TanStack
  Query (`@renderer/lib/queries/`; NO TanStack DB). Saves are explicit: draft state
  over the `['config']` query, sonner save/revert — never save per keystroke.
- **CLI** (`remote-agent`) — thin commander skin over `management/`.
- **`management/`** — the platform layer shared by CLI and GUI:
  provisioning, self-updating deploy with rollback, the doctor checklist
  (`checks.ts` — single source for CLI doctor AND the GUI status tables),
  the `supervisor/` seam, and `tunnel.ts` (`remote-agent tunnel`: login →
  create → route DNS → run cloudflared as a second supervised service
  `<label>.tunnel` → verify publicUrl; every step idempotent; doctor rows
  `tunnel-login`/`tunnel`/`tunnel-dns`/`tunnel-service`/`public-url`).
  **No shell scripts** — everything is TypeScript.
- **`lib/skills/`** — skill-composer boundary. Repos own skill-composer
  as their own dev dependency; we always **exec** their copy (or a bun child
  process for the inventory shim), never import repo-owned config in-process.
- **Thread registry** (`apps/server/services/sessions/threads.ts`) — conversation
  threads live in `RuntimeSessionResourceLink` (`comment-thread`, relationship
  `thread`/`question`): registered threads deliver without a mention or a
  router call; `question` threads frame the next human reply as the answer.
- **Plan capture** (`apps/server/services/sessions/plan-capture.ts`) — a
  workflow with `plan: { captureToIssue, thenState? }` launches its session
  in plan mode (`RuntimeSession.workflowId` records provenance); the acpx
  `onPermissionRequest` hook intercepts the exit-plan-mode approval (tool
  kind `switch_mode` + `rawInput.plan`), writes the plan into the source
  issue's `## Implementation Plan` section (spliced in place), transitions
  the issue to `thenState` only after the write succeeds, then defers to
  approve-all. Failures log and defer — never block the turn. Claude only.
- **Session tools + control socket** (`apps/server/mcp/`,
  `apps/server/control-socket.ts`) — every session's harness spawns the
  `remote-agent` stdio MCP server (registered via acpx `mcpServers`); it
  exposes `delegate_session` and `register_thread`, calling the same Hono
  routes over `controlIpcPath` (`createApp({ trustLocal: true })`, socket
  mode 0600, no bearer). Identity comes from `REMOTE_AGENT_SESSION_ID` /
  `REMOTE_AGENT_SOCKET`, injected into every session's env by
  `sessionEnvironment`. `delegateSession` copies the parent's non-thread
  resource links, sets `spawned-by`, role `delegate`, lifecycle `one-shot`.
- **Workflows** (`repositories.<id>.workflows`) — trigger (`on` +
  `when` conditions + optional `connectionId`) → skill (skillset + flags) →
  delivery (`start-session` | `message-session`). Matched in the webhook
  handlers (`apps/server/workflows/match.ts`), executed by the single workflow
  worker (`apps/server/workers/product/workflow/`), which composes
  `{{SKILL:skillset+flags}}` tokens via `composeForPrompt` inside the
  session's worktree.

## Layout

- `apps/server` (Hono entry, routes, middleware, ACP, services,
  integrations, workers, workflows, transports, Prisma), `apps/desktop`,
  `apps/cli` — the three artifacts. The shared kernel at the repo root is
  deliberately small: `lib/` (config, skills, machines), `management/`,
  `types/` (+ `generated/`, `test-support/` as tooling).
- The desktop app and CLI may import only `lib/`, `management/`, and
  `types/` — enforced by `test/contracts/app-boundaries.test.ts`.
  Everything under `apps/server` is server-only.

## Vocabulary (enforced across JSON, code, and UI)

- **provider** (codex | claude) — never "harness". Frozen carve-outs:
  skill-composer's own `harnesses` API; the `harness` JSON field key in the
  `/api/launches` and `/api/session-events` request bodies (wire contracts
  with repo hooks — internal identifiers around them still say provider);
  the "Harness session ID" description row and `Harness /` Linear labels
  (provider-side data formats).
- **label groups / labels** — `repositories.<id>.labels` +
  `sessionDefaults.labels`; `exclusive` (not cardinality), `routerVisible`.
  The Prisma `tags` rows are the one storage-internal exception, mapped to
  `labels` at every seam.
- **WebhookReceipt / SessionMirror** — provider-neutral storage: a receipt
  records one inbound delivery (`provider`, `deliveryId`, `resourceId` +
  `commentId` — container + threadable item); a session mirror is the
  provider-side object mirroring a session (Linear agent issue today).
  `WorkerRun.targetResourceId` names delivery targets. Provider-specific
  vocabulary (AgentIssue, Linear webhook shapes) belongs inside
  `apps/server/integrations/<provider>/` — documented exceptions: the
  agent-issue mirror lifecycle (`apps/server/services/sessions/lifecycle/
  agent-issue/`, `types/sessions/agent-issue.ts`) and the resolved-config
  `linearApiKey`/`agentTeamKey` accessors, both pending the multi-provider
  work; the `"Harness session ID"` string in
  agent-issue descriptions is Linear-side data format, not code vocabulary.
- **connection** owns machineId, repository allowlist, one webhook, router,
  editors. **machine** is physical (server, sockets, sshHost, installation).
- IDs are opaque (`wh-xxxx`, `repo-xxxx`); fields referencing them end in
  `Id`; maps are keyed by ID.

## Conventions

- Kebab-case file names. Explicit named exports in barrels, no `export *`.
- Worktree seam: the server owns git (`worktree add`, path flattening), the
  repository owns bootstrap (runs once per new worktree; exit code is the
  only signal; contents are the repo's business), the repository owns the branch convention
  (`branchNaming` templates keyed by connection, rendered from
  provider-supplied facts).
- Zod v4 schemas in `lib/config.ts` are the single config source; the UI
  mirrors the JSON shape exactly — when one changes, both change. TWO config
  files per repository: the app config's `repositories.<id>` holds machine
  truth (paths, worktree naming); the repo's committed
  `.remote-agent.config.json` (`RepoConfigSchema`, read at boot from the
  checkout root) holds team policy (bootstrap, skillsRoot, branchNaming,
  workflows, labels). BOTH are first-class watched config documents in the
  desktop app — one draft/dirty/save flow (`app-root.tsx` composite draft;
  `config-file.ts` document API); repo-config saves land in the repo's
  working tree for the user to commit. Committed `branchNaming` keys are
  portable only:
  `"*"` | `"linear"` | `"linear:<workspace>"` (connections carry an optional
  `workspace` identity); resolution is most-specific-first.
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

- **Restart matrix**: renderer (`apps/desktop/renderer/`) hot-reloads;
  `apps/desktop/main/`, `lib/`, `management/` need a full
  `bun run desktop:dev` restart; server changes need a server restart.
  Never kill the user's running dev app — tell them what needs restarting.
- **TWO live configs on the dev machine**: the server's
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
