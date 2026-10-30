const EMOJI_ALIASES: Record<string, readonly string[]> = {
  pencil2: ["✏️", "✏"],
  compass: ["🧭"],
  hourglass_flowing_sand: ["⏳"],
  eyes: ["👀"],
  speech_balloon: ["💬"],
  memo: ["📝"],
  rocket: ["🚀"],
  warning: ["⚠️", "⚠"],
  x: ["❌"],
};

export function normalizeReactionEmoji(value: string): string {
  return value.trim().replace(/^:+|:+$/g, "").replaceAll("\uFE0F", "");
}

export function matchesReactionEmoji(
  raw: string,
  configured: string,
): boolean {
  const expected = normalizeReactionEmoji(configured);
  if (normalizeReactionEmoji(raw) === expected) return true;
  return reactionEmojiTokens(raw).includes(expected);
}

/** Every token a raw reaction can match in workflow conditions: the
    normalized emoji itself plus any alias names (e.g. "pencil2"). */
export function reactionEmojiTokens(raw: string): string[] {
  const normalized = normalizeReactionEmoji(raw);
  const tokens = [normalized];
  for (const [name, aliases] of Object.entries(EMOJI_ALIASES)) {
    if (normalized === name || aliases.some((alias) => normalizeReactionEmoji(alias) === normalized)) {
      tokens.push(name, ...aliases.map(normalizeReactionEmoji));
    }
  }
  return [...new Set(tokens)];
}
