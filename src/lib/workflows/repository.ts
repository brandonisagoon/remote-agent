import { readFileSync } from "node:fs";
import path from "node:path";

import type { RepositoryConfig } from "../config.ts";

export type RepositoryWorkflow = keyof RepositoryConfig["workflows"];

export function repositoryPath(root: string, configuredPath: string): string {
  const resolved = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(root, configuredPath);
  const relative = path.relative(path.resolve(root), path.resolve(resolved));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`repository path escapes configured root: ${configuredPath}`);
  }
  return path.resolve(resolved);
}

export function workflowPromptPath(
  repository: RepositoryConfig,
  workflow: RepositoryWorkflow,
  root: string = repository.root,
): string {
  return repositoryPath(root, repository.workflows[workflow].prompt);
}

export function readWorkflowPrompt(
  repository: RepositoryConfig,
  workflow: RepositoryWorkflow,
  root?: string,
): string {
  const file = workflowPromptPath(repository, workflow, root);
  const prompt = readFileSync(file, "utf8").trim();
  if (!prompt) throw new Error(`${workflow} workflow prompt is empty: ${file}`);
  return prompt;
}

export function renderWorkflowPrompt(
  prompt: string,
  context: Record<string, string>,
): string {
  let rendered = prompt;
  for (const [name, value] of Object.entries(context)) {
    rendered = rendered.replaceAll(`{{${name}}}`, value);
  }
  const details = Object.entries(context).map(
    ([name, value]) => `- ${name}: ${value}`,
  );
  return `${rendered}\n\nWorkflow context\n${details.join("\n")}`;
}
