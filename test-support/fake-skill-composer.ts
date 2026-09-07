#!/usr/bin/env bun
// Stand-in for a repository's skill-composer CLI (pointed at via the
// REMOTE_AGENT_SKILL_COMPOSER env override). Mirrors the JSON contract:
// compose prints { ok, skill, compatibility }, check prints { ok, errors,
// warnings }. Skillset "missing" fails; "codex-only" composes with a single
// harness.
const args = process.argv.slice(2);

if (args[0] === "check") {
  console.log(JSON.stringify({ ok: true, errors: [], warnings: [] }));
  process.exit(0);
}

const skillset = args[args.indexOf("--skillset") + 1];
const flags: string[] = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--flag") flags.push(args[index + 1]!);
}

if (!skillset || skillset === "missing") {
  console.log(JSON.stringify({ ok: false, error: { code: "unknown_skillset", message: `Unknown skillset: ${skillset}` } }));
  process.exit(1);
}

const name = [
  "skill-composer",
  skillset,
  ...[...flags].sort().map((flag) => `flags-${flag}`),
].join("-");
console.log(JSON.stringify({
  ok: true,
  skill: name,
  compatibility: { harnesses: skillset === "codex-only" ? ["codex"] : ["claude", "codex"] },
}));
export {};
