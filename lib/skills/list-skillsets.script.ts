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
  frontmatter?: string | Record<string, string>;
  baseDirectory?: string;
  snippets?: ContentEntry[];
  flags?: ContentEntry[];
  hooks?: ContentEntry[];
}

// The skill's user-facing description lives in its frontmatter markdown; the
// config only points at the file. Variant files (.claude.md/.codex.md) count.
async function readDescription(skill: SkillEntry): Promise<string | null> {
  const { readFileSync, existsSync } = await import("node:fs");
  const path = await import("node:path");
  if (!skill.baseDirectory) return null;
  const source = typeof skill.frontmatter === "string"
    ? skill.frontmatter
    : Object.values(skill.frontmatter ?? {})[0];
  if (!source) return null;
  const base = path.resolve(skill.baseDirectory, source);
  const candidates = [base, base.replace(/\.md$/, ".claude.md"), base.replace(/\.md$/, ".codex.md")];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const match = readFileSync(file, "utf8").match(/^description:\s*(.+)$/m);
    if (match) return match[1]!.trim();
  }
  return null;
}

try {
  const module = (await import(configPath)) as { default?: { skills?: SkillEntry[] } };
  const skills = module.default?.skills ?? [];
  console.log(JSON.stringify({
    ok: true,
    skillsets: await Promise.all(skills
      .filter((skill) => skill.id)
      .map(async (skill) => ({
        id: skill.id,
        description: await readDescription(skill),
        harnesses: skill.harnesses ?? [],
        snippets: (skill.snippets ?? []).map((entry) => entry.id).filter(Boolean),
        flags: (skill.flags ?? [])
          .filter((entry) => entry.id)
          .map((entry) => ({ id: entry.id, ...(entry.harnesses ? { harnesses: entry.harnesses } : {}) })),
        hooks: (skill.hooks ?? []).map((entry) => entry.id).filter(Boolean),
      }))),
  }));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exit(1);
}
export {};
