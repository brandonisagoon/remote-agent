import { realpath } from "node:fs/promises";

const fetching = new Map<string, Promise<string>>();

async function git(root: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", root, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`Worktree base preparation failed: ${err.trim()}`);
  return out.trim();
}

async function fetchRemoteBase(root: string, remote: string, branch: string): Promise<string> {
  const source = `refs/heads/${branch}`;
  const target = `refs/remotes/${remote}/${branch}`;
  await git(root, ["check-ref-format", source]);
  await git(root, ["fetch", "--no-tags", "--no-recurse-submodules", "--", remote, `+${source}:${target}`]);
  return git(root, ["rev-parse", "--verify", "--end-of-options", `${target}^{commit}`]);
}

/** Linked checkouts and path aliases share the same Git registration directory. */
export async function resolveWorktreeCommonDirectory(root: string): Promise<string> {
  return realpath(await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
}

/** Remote branch bases must be fetched before a new launch pins its commit.
 * Local branches and explicit revisions keep their caller-selected meaning. */
export async function resolveWorktreeBase(root: string, base: string): Promise<string> {
  const trackingName = base.replace(/^refs\/remotes\//, "");
  const remotes = (await git(root, ["remote"])).split("\n").filter(Boolean).sort((a, b) => b.length - a.length);
  const remote = remotes.find((name) => trackingName.startsWith(`${name}/`));
  if (!remote) {
    const ref = await git(root, ["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", base]);
    if (ref.startsWith("refs/remotes/") || base.startsWith("refs/remotes/")) {
      throw new Error(`Cannot refresh worktree base ${base}: its Git remote is not configured`);
    }
    return git(root, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]);
  }
  let branch = trackingName.slice(remote.length + 1);
  if (branch === "HEAD") {
    const ref = await git(root, ["symbolic-ref", `refs/remotes/${remote}/HEAD`]);
    const prefix = `refs/remotes/${remote}/`;
    if (!ref.startsWith(prefix)) throw new Error(`Remote HEAD points outside ${remote}`);
    branch = ref.slice(prefix.length);
  }
  // Parallel launches may share one in-flight fetch, avoiding Git ref-lock races.
  // The result is forgotten immediately; later launches always fetch again.
  const key = JSON.stringify([root, remote, branch]);
  const pending = fetching.get(key);
  if (pending) return pending;
  const promise = fetchRemoteBase(root, remote, branch);
  fetching.set(key, promise);
  try { return await promise; } finally { fetching.delete(key); }
}
