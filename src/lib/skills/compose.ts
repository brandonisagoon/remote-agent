import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** Providers map 1:1 onto skill-composer harnesses. */
export type SkillHarness = "claude" | "codex";

export interface ComposedSkill {
  skill: string;
  harnesses: SkillHarness[];
}

export interface PromptSkillSelection {
  token: string;
  skillset: string;
  flags: string[];
}

/** `{{SKILL:skillset+flag+flag}}` — the placeholder grammar shared with
    Cubic's prompts, so hand-written seed prompts stay portable. */
const SKILL_PLACEHOLDER = /{{SKILL:([a-z0-9-]+)((?:\+[a-z0-9-]+)*)}}/g;

/** Test seam (and non-standard installs): overrides the composer binary. */
const CLI_ENV = "REMOTE_AGENT_SKILL_COMPOSER";

/** The managed repository owns skill-composer as its own devDependency; we
    always exec its copy, never import repo-owned config code in-process. */
export function skillComposerPath(repositoryRoot: string): string | null {
  const override = process.env[CLI_ENV];
  if (override) return override;
  const local = path.join(repositoryRoot, "node_modules", ".bin", "skill-composer");
  return existsSync(local) ? local : null;
}

export function renderSkillToken(selection: { skillset: string; flags: readonly string[] }): string {
  const flags = [...new Set(selection.flags)].sort();
  return `{{SKILL:${selection.skillset}${flags.map((flag) => `+${flag}`).join("")}}}`;
}

export function skillsetsFromPrompt(prompt: string): PromptSkillSelection[] {
  const selections = new Map<string, PromptSkillSelection>();
  for (const match of prompt.matchAll(SKILL_PLACEHOLDER)) {
    const skillset = match[1]!;
    const suffix = match[2] ?? "";
    const token = `${skillset}${suffix}`;
    selections.set(token, {
      token,
      skillset,
      flags: [...new Set(suffix.split("+").filter(Boolean))].sort(),
    });
  }
  return [...selections.values()];
}

interface ComposeCliResult {
  ok: boolean;
  skill?: string;
  compatibility?: { harnesses?: SkillHarness[] };
  error?: { message?: string };
}

async function runComposer(
  cli: string,
  args: string[],
  cwd: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cli, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => resolve({ exitCode: null, stdout, stderr: error.message }));
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

async function composeWorktreeSkill(
  worktreePath: string,
  selection: Pick<PromptSkillSelection, "skillset" | "flags">,
): Promise<ComposedSkill> {
  const cli = skillComposerPath(worktreePath);
  if (!cli) {
    throw new Error(
      `skill-composer is not installed in this repository (expected node_modules/.bin/skill-composer under ${worktreePath})`,
    );
  }
  const args = [
    "--skillset",
    selection.skillset,
    "--all",
    ...selection.flags.flatMap((flag) => ["--flag", flag]),
    "--root",
    worktreePath,
  ];
  const { exitCode, stdout, stderr } = await runComposer(cli, args, worktreePath);
  let result: ComposeCliResult;
  try {
    result = JSON.parse(stdout.trim()) as ComposeCliResult;
  } catch {
    throw new Error(
      `Skill composer returned invalid JSON for '${selection.skillset}': ${stdout.trim() || stderr.trim() || `exit ${exitCode}`}`,
    );
  }
  if (
    exitCode !== 0 ||
    !result.ok ||
    !result.skill ||
    !Array.isArray(result.compatibility?.harnesses)
  ) {
    throw new Error(
      result.error?.message ||
        stderr.trim() ||
        `Skill composer failed for '${selection.skillset}' (exit ${exitCode})`,
    );
  }
  return { skill: result.skill, harnesses: result.compatibility.harnesses };
}

export async function composeWorktreeSkills(
  worktreePath: string,
  selections: readonly PromptSkillSelection[],
): Promise<Map<string, ComposedSkill>> {
  const composedBySelection = new Map<string, Promise<ComposedSkill>>();
  const entries = await Promise.all(
    selections.map(async (selection) => {
      const key = [selection.skillset, ...selection.flags].join("+");
      let composed = composedBySelection.get(key);
      if (!composed) {
        composed = composeWorktreeSkill(worktreePath, selection);
        composedBySelection.set(key, composed);
      }
      return [selection.token, await composed] as const;
    }),
  );
  return new Map(entries);
}

export function resolveSkillPlaceholders(
  prompt: string,
  harness: SkillHarness,
  skills: Map<string, ComposedSkill>,
): string {
  return prompt.replace(SKILL_PLACEHOLDER, (_placeholder, skillset: string, suffix: string) => {
    const token = `${skillset}${suffix ?? ""}`;
    const composed = skills.get(token);
    if (!composed) throw new Error(`Unknown composed skillset '${token}'`);
    if (!composed.harnesses.includes(harness)) {
      throw new Error(`Composed skillset '${token}' is incompatible with '${harness}'`);
    }
    // Each harness invokes generated skills with its own sigil.
    return harness === "claude" ? `/${composed.skill}` : `$${composed.skill}`;
  });
}

/** Scan → compose (deduped) → resolve. The one call sites use. */
export async function composeForPrompt(
  worktreePath: string,
  prompt: string,
  harness: SkillHarness,
): Promise<string> {
  const selections = skillsetsFromPrompt(prompt);
  if (selections.length === 0) return prompt;
  const skills = await composeWorktreeSkills(worktreePath, selections);
  return resolveSkillPlaceholders(prompt, harness, skills);
}
