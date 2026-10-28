# Resume implementation after a planning workflow

The implementation reaction currently stops at the duplicate-session guard when an issue already has an idle planning session. Continue the existing session through the configured execution workflow instead of abandoning the request or creating another worktree.

1. Resolve a single primary session by repository, connection and source issue. Allow a different execution workflow to continue a planning session; retain duplicate protection for other live sessions. Respect task control and refuse a switch while work or uncertain delivery is outstanding.
2. Compose the execution skill from the task's pinned tooling. Use the existing provider-switch support, apply the execution model and leave plan mode. Preserve task/session identity, branch, base commit, worktree, source links and tooling pin. Record the workflow change with one durable instruction so retries cannot duplicate execution.
3. Add regression tests for planning-to-execution, provider/model selection, same-provider plan exit, retries, concurrent reactions, busy/paused sessions and failures. Run the repository's type check, tests and desktop build.
4. Deploy without interrupting active Air tasks. Resume DRA-8 from the accepted implementation request and verify actual execution, rather than only queue acceptance.
