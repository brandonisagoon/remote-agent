import { execFileSync } from "node:child_process";

export const TOOLING_POLICY_FILE = ".remote-agent.config.json";
const ObjectId = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

export interface ToolingSource {
  revision: string;
  tree: string;
  /** Git blob ID of the committed team policy file at `revision`. */
  policyBlob: string;
  settings: unknown;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function sourceAt(root: string, revision: string): ToolingSource {
  const tree = git(root, ["rev-parse", "--verify", "--end-of-options", `${revision}^{tree}`]);
  if (!ObjectId.test(tree)) throw new Error("Invalid tooling tree");
  const entry = git(root, ["ls-tree", revision, "--", TOOLING_POLICY_FILE]);
  const match = /^100644 blob ([a-f0-9]+)\t/.exec(entry);
  if (!match || !ObjectId.test(match[1]!)) throw new Error(`Tooling revision ${revision} has no committed regular ${TOOLING_POLICY_FILE}`);
  const source = execFileSync("git", ["-C", root, "cat-file", "blob", match[1]!], { encoding: "utf8" });
  return { revision, tree, policyBlob: match[1]!, settings: JSON.parse(source) };
}

/** Resolve policy and source from the same commit. Dirty checkout edits do
 * not silently change policy for a task pinned to an older revision. */
export function readToolingSource(root: string, ref: string): ToolingSource {
  const revision = git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (!ObjectId.test(revision)) throw new Error("Invalid tooling revision");
  return sourceAt(root, revision);
}

/** Exact durable selection: never resolves a moving ref. The revision must
 * already be a full commit ID present in the configured source repository. */
export function readToolingSourceAt(root: string, revision: string): ToolingSource {
  if (!ObjectId.test(revision)) throw new Error("Selected tooling revision must be a full commit ID");
  const resolved = git(root, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]);
  if (resolved !== revision) throw new Error(`Selected tooling revision ${revision} is not an exact commit in ${root}`);
  return sourceAt(root, revision);
}
