# Adoption guide

Remote Agent integrates three independently operated systems:

1. a bb project and its enrolled execution hosts;
2. a Linear workspace used for source issues and session mirrors;
3. a Git repository whose prompts and bootstrap command define how agent work starts.

The service makes no assumptions about organization name, checkout location, host names, or repository scripts.

## Host registry

Every host record in `remote-agent.config.json` has:

- `id`: stable lowercase kebab-case identity used by runtime events;
- `label`: human-facing label written to the Linear mirror;
- `bbHostId`: enrolled bb host ID;
- `zedConnection`: `local` or `ssh` for generated Zed links;
- `acceptsTrackerInput`: whether tracker routing may target the host;
- `default`: exactly one host must be the default.

IDs, labels, and bb host IDs must be unique. Set `runtime.machine` when one configuration is shared across several service hosts. If any host uses `ssh`, provide `runtime.zedRemoteHost`.

## Tracker port

Workers depend on the structural `TrackerPort` in `src/lib/integrations/tracker/port.ts`. Its consumed capabilities are:

- webhook signature verification, envelope parsing, and event handlers;
- comment create/read/update and threaded replies;
- reactions and mention matching/context lookup;
- the agent catalog and session-mirror registry;
- source-issue reads and related mirror issues;
- configured state/reaction triggers.

`src/lib/integrations/tracker/index.ts` is the worker-facing facade. The only implementation is Linear, contained in `src/lib/integrations/linear/`, including webhook schemas/handlers and the GraphQL-backed session store. A second tracker implementation is not part of the initial extraction.

## Host-repository contract

The `repository` object describes everything Remote Agent needs from a working repository:

```json
{
  "repository": {
    "root": "~/checkouts/your-repository",
    "worktreeRoot": "../.worktrees",
    "bootstrapCommand": ["bash", "scripts/bootstrap.sh"],
    "workflows": {
      "describe": {
        "prompt": "prompts/describe-issue.md",
        "harness": "claude",
        "model": "opus"
      },
      "orchestrate": {
        "prompt": "prompts/orchestrate-plan.md",
        "harness": "codex"
      },
      "reflect": {
        "prompt": "prompts/reflect.md"
      }
    }
  }
}
```

`root` is the full checkout used for one-shot describe work. `worktreeRoot` is resolved relative to `root` unless absolute. Orchestration creates `<worktreeRoot>/<sanitized-branch-name>` with `git worktree add`, then runs `bootstrapCommand` from the new worktree.

Prompt paths are resolved inside the selected checkout/worktree and must not escape it. Prompt templates support these literal placeholders:

- `{{sourceIssueIdentifier}}`
- `{{sourceIssueTitle}}`
- `{{sourceIssueLabels}}`
- `{{branchName}}`
- `{{sourceIssueState}}`

Only placeholders relevant to a workflow are populated. Missing or empty prompts fail before a session launch.

A minimal compatible fixture is a normal Git repository containing three prompt files and an executable/no-op bootstrap script. `src/lib/services/launches/provision-worktree.test.ts` constructs that fixture and verifies provisioning and prompt resolution from configuration alone.

## Cubic worked example

The source deployment that motivated the extraction can be represented entirely as adopter configuration:

```json
{
  "repository": {
    "root": "~/Desktop/cubic",
    "worktreeRoot": "../.worktrees",
    "bootstrapCommand": ["bash", "scripts/workspace/worktree/bootstrap.sh"],
    "workflows": {
      "describe": {
        "prompt": "scripts/workspace/linear/prompts/describe-issue.txt",
        "harness": "claude"
      },
      "orchestrate": {
        "prompt": "scripts/workspace/linear/prompts/orchestrate-plan-linear.txt",
        "harness": "codex"
      },
      "reflect": {
        "prompt": ".agents/skills/reflect-linear/SKILL.md"
      }
    }
  }
}
```

Those paths are examples owned by that adopter; none are defaults or referenced by production code.

## Installer inputs

The macOS installer takes one input: `REMOTE_AGENT_CONFIG`, the private service JSON path. The file contains credentials and must be kept out of Git; copy the committed example and set mode `0600`.

It derives launchd labels and install locations from `serviceName`, inherits the current checkout's Git remote by default, and accepts `deployment.gitRemote`, `deployment.branch`, and `deployment.installRoot` in the same file. It never reads a host-repository dotenv or encryption-key file.
