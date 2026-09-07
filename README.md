# Remote Agent

A headless server that runs coding-agent sessions on your machine.
Sessions are started by events in integrated apps ([Linear](https://linear.app) today), each one
in its own git worktree of your repository. The session is mirrored back
into your apps, so its state and conversation are visible there, and any
ACP client can attach to it from your editor.

Sessions run on the Codex and Claude Code CLIs installed on your machine,
under your own subscriptions.

## What it does

- Matches events from an integration against workflows you configure per
  repository: an issue entering a state, a reaction, a comment. Only
  configured triggers start work.
- For a new session, creates a git worktree on a branch named by your
  repository's template, runs your repository's bootstrap command in it,
  composes the workflow's skillset into the opening prompt, and starts the
  session.
- Routes follow-up messages to the right session. Threads a session owns
  deliver to it directly; new threads are matched by a router that reads
  the message alongside the session database.
- Mirrors every session into the integration as its own object (in Linear,
  an issue in an agent team) that tracks state, labels, and checkpoint
  comments, and carries editor links to the worktree.
- Exposes every session over ACP: attach from an editor with provider,
  model, mode, and thinking controls, plan-mode switching, and the agent's
  questions forwarded to you.
- Captures plans: a session started in plan mode writes its finished plan
  into the source issue and moves it to a configured state.

## Why

**One session, many surfaces.** A session has one stable ID. The
integration's mirror, its threads, and ACP clients all reference it, so
switching between your apps and your editor keeps the same history.

**Open protocols.** Clients connect through the
[Agent Client Protocol](https://agentclientprotocol.com); any ACP client
works. Sessions run on the provider CLIs directly.

**Headless.** The server has no UI. It is configured by JSON files,
supervised by launchd or Task Scheduler, and observed through your apps and
clients you already use. It runs the same locally or on a remote machine.
The CLI and the GUI are optional.

**Configurable by humans and agents.** Every setting is plain JSON with a
published schema. An agent can read, validate, and edit the configuration
as well as a human can.

**Pluggable integrations.** Webhook receipts, session mirrors, and resource
links are each tagged with the integration they came from, so Slack,
GitHub, and others attach at the same boundary as Linear.

**Multiplayer (coming soon).** Multiple humans in one session's thread, from
their apps or their editors, with the session mirrored to each of them.

**Traceability (coming soon).** Every agent action recorded and attributable:
the triggering event, the session, the tool calls, file edits, commands,
and comments it produced, and the state changes it caused. Viewable from
the session's mirror and queryable across sessions.

**BYOH, bring your own harness (coming soon).** Codex and Claude Code today;
any ACP-compatible harness eventually.

## How it works

### Ownership

| Owner | Responsible for |
|---|---|
| Server | Webhooks, routing, git worktrees, sessions, mirroring, storage |
| Repository, via committed `.remote-agent.config.json` | Bootstrap command, skillsets, branch naming, workflows, session labels |
| Machine, via local `remote-agent.config.json` | Paths, credentials, connections, worktree naming |
| Integration (Linear, Slack, GitHub) | Events, issue identifiers, suggested branch names |

Integrations supply data; the repository's templates and workflows decide
what to do with it.

### Sessions

A session is an [acpx](https://acpx.sh/) session on Codex or Claude Code
with a stable server-side ID.

- acpx owns the transcript and provider reconnect state.
- SQLite owns identity, labels, relationships, and resource links: the issue
  a session handles, the threads it owns, the mirror object in the
  integration.
- The mirror is the session's presence in the integration. In Linear it is
  an issue in a dedicated agent team, related to the source issue, with the
  session's state and labels, and checkpoint comments as turns complete.

Sessions survive restarts and disconnects. Closing an editor or dropping an
SSH connection does not end a session; only an explicit close or end does.

### Dependencies

- [acpx](https://acpx.sh/): session runtime; launches and reconnects the
  provider CLIs.
- [skill-composer](https://github.com/brandonisagoon/skill-composer): a dev
  dependency of your repository. A skillset is a directory of snippets:
  flags toggle optional snippets at compose time, snippets can be typed
  renderers that vary by provider, and frontmatter has per-provider
  variants (`frontmatter.claude.md`, `frontmatter.codex.md`). The server
  executes the repository's own copy to compose a skillset for the
  session's provider.
- [ACP SDK](https://agentclientprotocol.com): the client-facing protocol.

### Pipeline

1. A webhook arrives at a connection's endpoint. The signature is verified
   and a receipt is recorded for idempotency.
2. The repository's workflows are matched: trigger, conditions, skillset,
   delivery. A match starts a session or messages the running one.
3. For a new session, the branch name is rendered from the repository's
   template and the issue's data, `git worktree add` runs, then the
   repository's bootstrap command runs in the new worktree. A non-zero exit
   fails the launch.
4. The workflow's skillset is composed by the repository's skill-composer in
   the worktree and becomes the session's opening instruction.
5. The session runs. Its mirror is created in the integration, and the
   source issue gets one editor deep link per configured editor, local or
   over SSH.
6. Replies in a thread the session owns route to it directly. New threads go
   through a semantic router that reads the comment alongside the session
   database. Agent questions are framed as questions; the reply arrives as
   the answer.
7. A workflow can start its session in plan mode. When the agent exits plan
   mode, the server writes the plan into the issue's `## Implementation
   Plan` section and moves the issue to the configured state.

## Features

- Workflows: `issue.state-changed` and `issue.reaction` triggers with
  conditions, mapped to skillsets, delivered as a new session or a message
  to the running one.
- Isolated worktrees with branch and worktree naming templates
  (`{branch}`, `{issue}`, `{title}`), per integration or per workspace.
- Thread routing: registered threads deliver without a mention; question
  threads frame replies as answers; a semantic router handles new threads.
- Plan capture into the source issue, with a state transition.
- Session labels: Linear-style label groups skills use to mark a session's
  phase; router-visible groups inform routing.
- ACP for any client: provider, model, mode, and thinking controls;
  plan-mode switching; elicitation forwarding; restored context usage.
- Editor deep links for Zed, VS Code, Cursor, and any URL-scheme app, local
  or over SSH.
- GUI and CLI on one release cadence. The GUI edits both config
  files with explicit save/revert, shows the doctor checklist with buttons,
  and lists sessions. The CLI provides `install`, `doctor`, `status`,
  `restart`, `check-update`, `update` (with rollback), and `uninstall`.
- Self-updating installs supervised by launchd (macOS) or a Task Scheduler
  logon task (Windows).

## Setup

**1. Install the CLI.** This repo is its own Homebrew tap (formula and
cask) and Scoop bucket.

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

> Until the first tagged release exists, install from a clone instead:
> `git clone`, `bun install`, copy `remote-agent.config.example.json` to
> `remote-agent.config.json` and edit it, then run `bun run cli -- install`
> from the clone root. Config discovery is relative to the working
> directory.

**2. Provision the server.**

```sh
remote-agent install
```

This clones the repo into an app directory, builds it, migrates the
database, and registers the server to start at login (a launchd user agent
on macOS, a Task Scheduler logon task on Windows). It runs in your login
session because the agent sessions use your credentials.

**3. Run the checklist.**

```sh
remote-agent doctor
```

`doctor` reports every prerequisite with what to do about it. The parts no
installer can do for you:

- **Cloudflare tunnel.** Linear needs a public URL to deliver webhooks:
  `cloudflared tunnel login`, create a tunnel, and add the DNS record (the
  GUI's Server section shows the exact record to create).
- **Linear.** An API key, plus the webhook URL and secret from your
  connection settings pasted into Linear's webhook settings.
- **Provider CLIs.** Install and authenticate `codex` and/or `claude`
  yourself; they are your identity and subscription, never installed for
  you. Their presence enables the matching provider.

**4. Adopt a repository.** Add skill-composer as a dev dependency, author
skillsets under `agent-skills/`, and commit a `.remote-agent.config.json`
(schema and example in this repo) declaring the bootstrap command,
workflows, and labels. Then add the checkout to your machine config. See
[docs/adoption.md](docs/adoption.md) for the full contract.

**5. Optionally install the GUI.** From the same tap and bucket:

macOS:

```sh
brew install --cask remote-agent
```

Windows:

```powershell
scoop install remote-agent-gui
```

Or download it from the
[releases page](https://github.com/brandonisagoon/remote-agent/releases)
(DMG on macOS, installer on Windows). It edits both config files with a
settings UI, shows the same checklist as `doctor` with buttons attached,
and lists sessions. Every release ships the CLI and GUI together, one
version.

**6. Attach an ACP client.** Configure Zed, bb, or T3 Code to run
`bun run acp`. The machine page shows the exact command. The bridge is a
stateless stdio connection to the server's socket.

## Configuration

Two files per repository, each holding what belongs to it:

- `remote-agent.config.json` (machine-local, gitignored): `machine`
  (server, sockets, storage, SSH host, install/update settings),
  `providers`, `connections` (a Linear workspace: credentials, workspace
  identity, webhook, router, editors), and `repositories.<id>` (checkout
  root, worktree root, worktree naming).
- `.remote-agent.config.json` (committed in the repository): bootstrap
  command, skillsets root, branch naming, workflows, label groups.

Both have published JSON schemas for editor completion:
[remote-agent.config.schema.json](remote-agent.config.schema.json) and
[remote-agent.repo-config.schema.json](remote-agent.repo-config.schema.json);
examples: [remote-agent.config.example.json](remote-agent.config.example.json)
and [remote-agent.repo-config.example.json](remote-agent.repo-config.example.json).

---

Working on Remote Agent itself? See [DEVELOPMENT.md](DEVELOPMENT.md).
