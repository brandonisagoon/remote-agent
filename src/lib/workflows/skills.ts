import type { Harness } from "../../types/runtime/index.ts";

export interface ComposeOptions {
  skillset: string;
  selection: {
    snippets: string[];
    hooks: string[];
    flags: string[];
    allSnippets: boolean;
    allHooks: boolean;
  };
  root: string;
}

export interface ComposeResult {
  skill: string;
  skillset: string;
  compatibility: { harnesses: Harness[] };
  snippets: string[];
  hooks: string[];
  flags: string[];
  writes: string[];
}

export function skillInvocation(harness: Harness, skill: string): string {
  return harness === "claude" ? `/${skill}` : `$${skill}`;
}

/**
 * The embedded Cubic skill composer is intentionally outside this repository.
 * Repository workflow prompts replace this transition seam in the adoption
 * contract; keeping the error explicit prevents a silent partial extraction.
 */
export async function composeSkill(
  _options: ComposeOptions,
): Promise<ComposeResult> {
  throw new Error(
    "embedded skill composition is not included; configure repository workflow prompts",
  );
}
