import { execFileSync } from "node:child_process";

/** Resolve policy and source from the same commit. Dirty checkout edits do
 * not silently change policy for a task pinned to an older revision. */
export function readToolingSource(root: string, ref: string): { revision: string; settings: unknown } {
  const revision = execFileSync("git", ["-C", root, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error("Invalid tooling revision");
  const source = execFileSync("git", ["-C", root, "show", `${revision}:.remote-agent.config.json`], { encoding: "utf8" });
  return { revision, settings: JSON.parse(source) };
}
