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

export interface TunnelInfo {
  tunnelId: string | null;
  /** Why tunnelId is null. */
  reason?: "cli-missing" | "not-found";
}

const cache = new Map<string, { at: number; info: TunnelInfo }>();
const CACHE_TTL_MS = 60_000;

/** Looks up the Cloudflare tunnel UUID for a tunnel name. */
export async function tunnelInfo(name: string): Promise<TunnelInfo> {
  const cached = cache.get(name);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.info;
  const binary = cloudflaredPath();
  const info = await (async (): Promise<TunnelInfo> => {
    if (!binary) return { tunnelId: null, reason: "cli-missing" };
    return new Promise<TunnelInfo>((resolve) => {
      execFile(binary, ["tunnel", "list", "--output", "json"], { timeout: 10_000 }, (error, stdout) => {
        if (error) return resolve({ tunnelId: null, reason: "not-found" });
        try {
          const tunnels = JSON.parse(stdout) as Array<{ id?: string; name?: string }>;
          const tunnelId = tunnels.find((tunnel) => tunnel.name === name)?.id ?? null;
          resolve(tunnelId ? { tunnelId } : { tunnelId: null, reason: "not-found" });
        } catch {
          resolve({ tunnelId: null, reason: "not-found" });
        }
      });
    });
  })();
  cache.set(name, { at: Date.now(), info });
  return info;
}
