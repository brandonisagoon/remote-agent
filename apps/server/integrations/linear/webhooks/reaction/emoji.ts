const EMOJI_ALIASES: Record<string, readonly string[]> = {
  pencil2: ["✏️", "✏"],
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
  return (EMOJI_ALIASES[expected] ?? []).some(
    (alias) => normalizeReactionEmoji(alias) === normalizeReactionEmoji(raw),
  );
}

/** Every token a raw reaction can match in workflow conditions: the
    normalized emoji itself plus any alias names (e.g. "pencil2"). */
export function reactionEmojiTokens(raw: string): string[] {
  const normalized = normalizeReactionEmoji(raw);
  const tokens = [normalized];
  for (const [name, aliases] of Object.entries(EMOJI_ALIASES)) {
    if (aliases.some((alias) => normalizeReactionEmoji(alias) === normalized)) {
      tokens.push(name);
    }
  }
  return tokens;
}
