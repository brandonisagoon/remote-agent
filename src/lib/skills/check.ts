import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { findExecutable, sourceRoot } from "../../management/paths.ts";
import { skillComposerPath } from "./compose.ts";

export interface SkillsetFlag {
  id: string;
  harnesses?: string[];
}

export interface SkillsetSummary {
  id: string;
  description?: string | null;
  harnesses: string[];
  snippets: string[];
  flags: SkillsetFlag[];
  hooks: string[];
}

export interface SkillsCheck {
  /** skill-composer present as the repository's own dependency. */
  installed: boolean;
  /** skillsRoot config file exists. */
  configFound: boolean;
  /** .gitignore covers the generated .claude/.agents skill outputs. */
  gitignored: boolean;
  /** `skill-composer check` verdict; problems are its errors+warnings. */
  ok: boolean;
  problems: string[];
  skillsets: SkillsetSummary[];
}

async function runJson(
  executable: string,
  args: string[],
  cwd: string,
): Promise<Record<string, unknown> | null> {
  const stdout = await new Promise<string>((resolve) => {
    const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(output));
  });
  try {
    return JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Generated harness outputs must never be committed; a heuristic substring
    check against the repo's .gitignore. */
function outputsIgnored(repositoryRoot: string): boolean {
  try {
    const gitignore = readFileSync(path.join(repositoryRoot, ".gitignore"), "utf8");
    return gitignore.includes(".claude/skills") && gitignore.includes(".agents/skills");
  } catch {
    return false;
  }
}

function configPath(repositoryRoot: string, skillsRoot: string): string {
  const base = path.join(repositoryRoot, skillsRoot, "skill-composer.config");
  return existsSync(`${base}.ts`) ? `${base}.ts` : `${base}.mjs`;
}

/** Read-only scan of a repository's skillsets: `check` for validity plus a
    sandboxed child-process import of the repo's config for the inventory
    (check validates but does not list). Powers the Skills tab and the
    workflow editor's pickers. */
export async function checkSkills(
  repositoryRoot: string,
  skillsRoot = "agent-skills",
): Promise<SkillsCheck> {
  const cli = skillComposerPath(repositoryRoot);
  const config = configPath(repositoryRoot, skillsRoot);
  const configFound = existsSync(config);
  const gitignored = outputsIgnored(repositoryRoot);
  if (!cli || !configFound) {
    return { installed: cli !== null, configFound, gitignored, ok: false, problems: [], skillsets: [] };
  }
  const checkResult = await runJson(
    cli,
    ["check", "--root", repositoryRoot, "--config", config],
    repositoryRoot,
  );
  const messages = [
    ...((checkResult?.errors as Array<{ message?: string }> | undefined) ?? []),
    ...((checkResult?.warnings as Array<{ message?: string }> | undefined) ?? []),
  ]
    .map((message) => message.message)
    .filter((message): message is string => Boolean(message));
  if (checkResult && checkResult.ok === false && (checkResult.error as { message?: string } | undefined)?.message) {
    messages.push((checkResult.error as { message: string }).message);
  }

  const bun = findExecutable("bun");
  // Resolved from the source tree, not import.meta: the Electron main is a
  // bundle and this script runs as a file in a child bun process.
  const script = path.join(sourceRoot(), "src", "lib", "skills", "list-skillsets.script.ts");
  const inventory = bun ? await runJson(bun, [script, config], repositoryRoot) : null;
  const skillsets = inventory?.ok === true
    ? (inventory.skillsets as SkillsetSummary[])
    : [];
  if (inventory && inventory.ok !== true && typeof inventory.error === "string") {
    messages.push(inventory.error);
  }

  return {
    installed: true,
    configFound,
    gitignored,
    ok: checkResult?.ok === true && (inventory?.ok === true || inventory === null),
    problems: messages,
    skillsets,
  };
}
