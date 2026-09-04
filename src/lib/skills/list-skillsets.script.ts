#!/usr/bin/env bun
// Runs in a throwaway child process: imports a repository's skill-composer
// config (repo-owned TypeScript — never loaded into remote-agent's own
// process) and prints the skillset inventory as JSON. skill-composer's
// `check` validates but does not list, so this shim is the inventory source
// for the Skills tab and workflow pickers.
const configPath = process.argv[2];
if (!configPath) {
  console.log(JSON.stringify({ ok: false, error: "usage: list-skillsets <config-path>" }));
  process.exit(1);
}

interface ContentEntry { id?: string; harnesses?: string[] }
interface SkillEntry {
  id?: string;
  harnesses?: string[];
  snippets?: ContentEntry[];
  flags?: ContentEntry[];
  hooks?: ContentEntry[];
}

try {
  const module = (await import(configPath)) as { default?: { skills?: SkillEntry[] } };
  const skills = module.default?.skills ?? [];
  console.log(JSON.stringify({
    ok: true,
    skillsets: skills
      .filter((skill) => skill.id)
      .map((skill) => ({
        id: skill.id,
        harnesses: skill.harnesses ?? [],
        snippets: (skill.snippets ?? []).map((entry) => entry.id).filter(Boolean),
        flags: (skill.flags ?? [])
          .filter((entry) => entry.id)
          .map((entry) => ({ id: entry.id, ...(entry.harnesses ? { harnesses: entry.harnesses } : {}) })),
        hooks: (skill.hooks ?? []).map((entry) => entry.id).filter(Boolean),
      })),
  }));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exit(1);
}
export {};
