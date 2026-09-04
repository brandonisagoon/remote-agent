# Multi-repository adoption

Each machine runs one Remote Agent daemon configured by one
`remote-agent.config.json`. That file can declare multiple repositories,
Linear connections, and inbound webhooks. Copy the committed example and keep
the credential-bearing file untracked.

## Repository-owned contract

The managed repository provides:

- a stable checkout at `repositories.<id>.root`;
- a worktree parent at `repositories.<id>.worktreeRoot`;
- `repositories.<id>.bootstrapCommand`, invoked in a new worktree;
- [skill-composer](https://github.com/brandonisagoon/skill-composer) as a dev
  dependency, with skillsets under `repositories.<id>.skillsRoot` (default
  `agent-skills/`) — the instructions workflows compose into sessions;
- any project-specific tools, dependencies, or authentication needed by the
  configured Codex/Claude commands.

The bootstrap command should be idempotent and must create the workspace stamp
files expected by the worktree readiness check.

## Service-owned contract

Remote Agent owns:

- webhook authentication and replay protection;
- workflow trigger matching (`repositories.<id>.workflows`: an event, optional
  `when` conditions, a skillset + flags, and a delivery — `start-session`
  provisions a worktree, composes the skill, and spawns a session;
  `message-session` composes in the running session's worktree and forwards);
- worktree creation and skill composition (always the repository's own
  skill-composer binary, executed in a child process);
- stable runtime identity, tags, relationships, and integration links in SQLite;
- acpx/provider execution and Zed ACP translation;
- registry-backed routing and shutdown.

Custom tag definitions and selector options live under the repository that
owns them. SQLite stores only string keys and values. The names in the example
config use an `example.*` prefix deliberately; they are examples, not built-in
Remote Agent vocabulary.

Named Linear credentials live in `connections`. Each connection owns its
machine binding, repository allowlist, and one inbound `webhook`
(slug + secret). Within `when` — both in connection repository routing and in
workflow conditions — objects are OR alternatives, keys in an object are AND
conditions, and each key's values are OR choices. Ambiguous or unmatched events
fail closed.

The singular `machine` object owns the local server, ACP sockets, storage,
SSH host for editor links, installation, and update settings. Remote Agent
does not orchestrate a fleet in this version.

## Configuration lifecycle

1. Launch the desktop app with `bun run desktop:dev`, or copy
   `remote-agent.config.example.json` to `remote-agent.config.json`.
2. Set the repository paths, credentials, machine settings, and optional acpx agent
   command overrides.
3. Run `bun run db:deploy`, then start the machine daemon with `bun run start`.
4. Configure Zed to run `bun run acp`; this is a stateless stdio bridge to the
   daemon socket, not a second runtime.
5. Persist both the SQLite file and `acpx.stateDir` across deploys.

The desktop app and CLI operate on exactly this JSON file. The app watches the
file and surfaces external changes without overwriting an unsaved UI draft.
Its **Open in Code Editor** action opens the file directly, and the adjacent
committed JSON Schema provides field completion and validation.

No dotenv file is read. `REMOTE_AGENT_CONFIG` may point to a differently named
JSON file when required by deployment layout.
