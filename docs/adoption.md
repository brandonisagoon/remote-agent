# Per-repository adoption

Each Remote Agent deployment manages one repository through a single
`remote-agent.config.json`. Copy the committed example, keep the real file
untracked, and fill in these integration points.

## Repository-owned contract

The managed repository provides:

- a stable checkout at `repository.root`;
- a worktree parent at `repository.worktreeRoot`;
- `repository.bootstrapCommand`, invoked inside a newly provisioned worktree;
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
- stable runtime and Linear mirror identity in SQLite;
- acpx/provider execution and Zed ACP translation;
- turn lifecycle projection, routing, reconciliation, and shutdown.

Execution targets in `hosts` have an arbitrary kebab-case ID, a unique Linear
label, a Zed connection kind (`local` or `ssh`), routing capability, and exactly
one default. If any target uses SSH, configure `runtime.zedRemoteHost`.

## Configuration lifecycle

1. Copy `remote-agent.config.example.json` to
   `remote-agent.config.json` next to the deployment checkout.
2. Set the repository paths, credentials, target labels, and optional acpx agent
   command overrides.
3. Run `bun run db:deploy` and then start the HTTP and ACP entrypoints.
4. Persist both the SQLite file and `acpx.stateDir` across deploys.

No dotenv file is read. `REMOTE_AGENT_CONFIG` may point to a differently named
JSON file when required by deployment layout.
