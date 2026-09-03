import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const CLOUDFLARED_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

function cloudflaredPath(): string | null {
  for (const dir of [...(process.env.PATH ?? "").split(":"), ...CLOUDFLARED_DIRS]) {
    if (!dir) continue;
    const candidate = path.join(dir, "cloudflared");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const cache = new Map<string, { at: number; tunnelId: string | null }>();
const CACHE_TTL_MS = 60_000;

/** Looks up the Cloudflare tunnel UUID for a tunnel name; null when
    cloudflared is missing, not authenticated, or the tunnel doesn't exist. */
export async function tunnelInfo(name: string): Promise<{ tunnelId: string | null }> {
  const cached = cache.get(name);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return { tunnelId: cached.tunnelId };
  const binary = cloudflaredPath();
  if (!binary) return { tunnelId: null };
  const tunnelId = await new Promise<string | null>((resolve) => {
    execFile(binary, ["tunnel", "list", "--output", "json"], { timeout: 10_000 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const tunnels = JSON.parse(stdout) as Array<{ id?: string; name?: string }>;
        resolve(tunnels.find((tunnel) => tunnel.name === name)?.id ?? null);
      } catch {
        resolve(null);
      }
    });
  });
  cache.set(name, { at: Date.now(), tunnelId });
  return { tunnelId };
}
