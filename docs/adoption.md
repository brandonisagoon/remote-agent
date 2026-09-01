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
- prompt files for describe, orchestrate, and reflect workflows;
- any project-specific tools, dependencies, or authentication needed by the
  configured Codex/Claude commands.

Prompt paths must remain inside the repository. The bootstrap command should be
idempotent and must create the workspace stamp files expected by the worktree
readiness check.

## Service-owned contract

Remote Agent owns:

- webhook authentication and replay protection;
- worktree creation and workflow dispatch;
- stable runtime identity, tags, relationships, and integration links in SQLite;
- acpx/provider execution and Zed ACP translation;
- registry-backed routing and shutdown.

Custom tag definitions and selector options live under the repository that
owns them. SQLite stores only string keys and values. The names in the example
config use an `example.*` prefix deliberately; they are examples, not built-in
Remote Agent vocabulary.

Named Linear credentials live in `connections`. Each inbound definition under
`server.webhooks` references one connection and contains its own
`repositoryRouting` map. Those map keys are the webhook's repository allowlist.
Within `when`, objects are OR alternatives, keys in an object are AND
conditions, and each key's values are OR choices. Ambiguous or unmatched events
fail closed.

Execution targets in `hosts` have an arbitrary kebab-case ID, a unique Linear
label, a Zed connection kind (`local` or `ssh`), routing capability, and exactly
one default. If any target uses SSH, configure `runtime.zedRemoteHost`.

## Configuration lifecycle

1. Copy `remote-agent.config.example.json` to
   `remote-agent.config.json` next to the deployment checkout.
2. Set the repository paths, credentials, target labels, and optional acpx agent
   command overrides.
3. Run `bun run db:deploy`, then start the machine daemon with `bun run start`.
4. Configure Zed to run `bun run acp`; this is a stateless stdio bridge to the
   daemon socket, not a second runtime.
5. Persist both the SQLite file and `acpx.stateDir` across deploys.

No dotenv file is read. `REMOTE_AGENT_CONFIG` may point to a differently named
JSON file when required by deployment layout.
