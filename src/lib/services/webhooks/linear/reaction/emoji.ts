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
