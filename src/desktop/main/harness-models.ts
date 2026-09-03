import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Shown when the installed binary can't be found or scanned. */
const FALLBACK_MODELS: Record<string, string[]> = {
  codex: [
    "gpt-5.3-codex",
    "gpt-5.2-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "gpt-5.6",
    "gpt-5.6-pro",
  ],
  claude: ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
};

const MODEL_PATTERNS: Record<string, { match: RegExp; exclude: RegExp }> = {
  codex: {
    match: /^gpt-\d+(?:\.\d+)?(?:-[a-z0-9]+)*$/,
    exclude: /(tts|transcribe|audio|realtime|embed|image|moderation|search|instruct|chat)/,
  },
  claude: {
    match: /^claude-(?:\d|opus|sonnet|haiku|fable|mythos)[a-z0-9-]*[a-z0-9]$/,
    exclude: /(count|latest)$/,
  },
};

/** Prose fragments that ride along with model ids in binary strings. */
const NOISE_SEGMENTS = new Set([
  "family", "only", "specific", "style", "series", "model", "models",
  "level", "tier", "based", "compatible", "support", "and", "or", "the",
  "with", "for", "like", "default",
]);

function isNoise(token: string): boolean {
  if (/[.-]$/.test(token)) return true;
  return token.split("-").some((segment) => NOISE_SEGMENTS.has(segment));
}

/** Drops dated variants when their undated alias is also present. */
function collapseDated(models: string[]): string[] {
  const set = new Set(models);
  return models.filter((model) => {
    const undated = model.replace(/-\d{8}$/, "");
    return undated === model || !set.has(undated);
  });
}

const MAX_SCAN_BYTES = 400 * 1024 * 1024;
const cache = new Map<string, { key: string; models: string[] }>();

function candidateDirs(): string[] {
  const home = homedir();
  return [
    ...(process.env.PATH ?? "").split(":").filter(Boolean),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".claude", "local"),
  ];
}

function resolveBinary(command: string): string | null {
  const tryPath = (candidate: string): string | null => {
    try {
      return existsSync(candidate) ? realpathSync(candidate) : null;
    } catch {
      return null;
    }
  };
  if (command.includes("/")) return tryPath(command);
  for (const dir of candidateDirs()) {
    const resolved = tryPath(path.join(dir, command));
    if (resolved) return resolved;
  }
  return null;
}

/** Extracts model-id-shaped ASCII tokens from the binary. */
function scanBinary(file: string, harnessId: string): string[] {
  const pattern = MODEL_PATTERNS[harnessId];
  if (!pattern) return [];
  const buffer = readFileSync(file);
  const found = new Set<string>();
  let start = -1;
  const isTokenByte = (byte: number) =>
    (byte >= 48 && byte <= 57) || // 0-9
    (byte >= 97 && byte <= 122) || // a-z
    (byte >= 65 && byte <= 90) || // A-Z
    byte === 45 || byte === 46 || byte === 95; // - . _
  for (let index = 0; index <= buffer.length; index += 1) {
    const inToken = index < buffer.length && isTokenByte(buffer[index]!);
    if (inToken && start < 0) start = index;
    if (!inToken && start >= 0) {
      const length = index - start;
      if (length >= 5 && length <= 48) {
        const token = buffer.toString("latin1", start, index).toLowerCase();
        if (pattern.match.test(token) && !pattern.exclude.test(token) && !isNoise(token)) found.add(token);
      }
      start = -1;
    }
  }
  return [...found];
}

function versionKey(model: string): number[] {
  return (model.match(/\d+/g) ?? []).map(Number);
}

function byVersionDesc(a: string, b: string): number {
  const va = versionKey(a);
  const vb = versionKey(b);
  for (let index = 0; index < Math.max(va.length, vb.length); index += 1) {
    const diff = (vb[index] ?? 0) - (va[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}

export function listHarnessModels(
  harnessId: string,
  agents: Record<string, { command?: string[] } | undefined>,
): string[] {
  const fallback = FALLBACK_MODELS[harnessId] ?? [];
  const command = agents[harnessId]?.command?.[0] ?? harnessId;
  const binary = resolveBinary(command === "claude-code" ? "claude" : command);
  if (!binary) return fallback;
  try {
    const stats = statSync(binary);
    if (stats.size > MAX_SCAN_BYTES) return fallback;
    const key = `${stats.mtimeMs}:${stats.size}`;
    const cached = cache.get(binary);
    if (cached?.key === key) return cached.models;
    const scanned = collapseDated(scanBinary(binary, harnessId).sort(byVersionDesc)).slice(0, 12);
    const models = scanned.length > 0 ? scanned : fallback;
    cache.set(binary, { key, models });
    return models;
  } catch {
    return fallback;
  }
}
