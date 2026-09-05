# Remote Agent

Run durable coding-agent sessions on your own machine, driven from Linear.
Mention or assign the agent on an issue and Remote Agent starts a session in
an isolated worktree, routes follow-up comments to the right session (replies
in an established thread need no re-mention), and posts links that open the
work in your editor. Sessions are executed by
[acpx](https://acpx.sh/) using the provider CLIs you already have — Codex
and/or Claude Code — with your own subscriptions and credentials.

## Install

**1. Install the CLI** (this repo is its own Homebrew tap / Scoop bucket):

macOS:

```sh
brew tap brandonisagoon/remote-agent https://github.com/brandonisagoon/remote-agent
brew install remote-agent
```

Windows:

```powershell
scoop bucket add remote-agent https://github.com/brandonisagoon/remote-agent
scoop install remote-agent
```

This also installs the runtime dependencies, Bun and cloudflared.

**2. Create your config and provision the daemon:**

```sh
remote-agent install
```

This clones the repo into an app directory, builds it, migrates the database,
and registers the daemon to start at login (a launchd user agent on macOS, a
Task Scheduler logon task on Windows — your login session, because the agent
sessions use your credentials).

**3. Run the checklist and finish the manual steps:**

```sh
remote-agent doctor
```

`doctor` reports every prerequisite with what to do about it. The parts no
installer can do for you:

- **Cloudflare tunnel** — Linear needs a public URL to deliver webhooks:
  `cloudflared tunnel login`, create a tunnel, and add the DNS record (the
  desktop app's Server section shows the exact record to create).
- **Linear** — an API key, plus the webhook URL and secret from your
  connection settings pasted into Linear's webhook settings.
- **Provider CLIs** — install and authenticate `codex` and/or `claude`
  yourself; they are your identity and subscription, never installed for you.
  Their presence enables the matching provider.

**4. (Optional) Install the desktop app** from the
[releases page](https://github.com/brandonisagoon/remote-agent/releases) —
DMG on macOS, installer on Windows. It is the primary configuration surface:
it edits the same JSON config with a full settings UI, shows the same
checklist as `doctor` with buttons attached, and displays session state. Every
release ships the CLI and app together, one version.

Day-to-day commands: `status`, `restart`, `check-update`, `update` (pull,
rebuild, migrate, restart — rolls back on failure), `uninstall [--purge]`.

## How it works

- A **connection** binds a Linear workspace to this machine: which
  repositories sessions may work in, one inbound webhook, the session router
  (the model that reads incoming comments alongside the session database and
  picks the session to deliver them to), and the editors worktree links open
  in.
- Each **repository** you manage gets sessions in isolated worktrees, prepared
  by its own bootstrap command. Optional **workflows** react to Linear events
  (a state change, a reaction) by composing one of the repo's own
  [skill-composer](https://github.com/brandonisagoon/skill-composer) skillsets
  into the worktree and either starting a session or messaging the running
  one. A workflow can also start its session in plan mode: the daemon
  captures the finished plan when the agent asks to exit plan mode, writes it
  into the source issue's description under `## Implementation Plan`, and
  then moves the issue to a configured state — the agent never touches Linear
  for either step.
- When a session's worktree is ready, the Linear issue gets one deep link per
  configured editor — opening locally, or over SSH when your editors run on a
  different machine than the daemon.

## Configuration

Everything lives in one gitignored JSON file, `remote-agent.config.json`,
mirrored exactly by the desktop app's pages:

- `machine` — this installation: server, sockets, storage, SSH host for editor
  links, install/update settings.
- `providers.{codex,claude}` — presence enables a provider; optional `command`
  overrides acpx's built-in adapter launch.
- `connections.<id>` — a Linear workspace: credentials, machine binding,
  repository allowlist, webhook, router, editors.
- `repositories.<id>` — a managed checkout: `root`, `worktreeRoot`,
  `bootstrapCommand`, its skill-composer `skillsRoot`, `workflows`
  (trigger → conditions → skillset → delivery), and session label groups.

See [remote-agent.config.example.json](remote-agent.config.example.json) for
every setting and [docs/adoption.md](docs/adoption.md) for what a managed
repository must provide.

## Editor integrations

Worktree deep links support Zed, VS Code, and Cursor (any app with a URL
scheme works for local links). Zed users can additionally attach to running
sessions over ACP — the `bun run acp` stdio bridge connects Zed to the daemon
with full controls (provider, model, mode, thinking level) and restored
context usage across reconnects.

## Data

Session state lives in the service's SQLite database; acpx keeps transcripts
under its own state directory. Both survive restarts — an editor or SSH
disconnect never closes a session, and explicit close/end operations are what
mark one closed.

---

Working on Remote Agent itself? See [DEVELOPMENT.md](DEVELOPMENT.md).
