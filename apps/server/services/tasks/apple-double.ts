/** Container validation shared with the existing recovery-tar reader. Data
 * remains in the retained archive; no resource fork or attribute is applied. */
export function assertAppleDoubleMetadata(bytes: Buffer) {
  if (bytes.length < 26 || bytes.readUInt32BE(0) !== 0x00051607 || bytes.readUInt32BE(4) !== 0x00020000) throw new Error("Unlisted recovery tar member is not AppleDouble metadata");
  const count = bytes.readUInt16BE(24), end = 26 + count * 12, spans: Array<[number, number]> = [];
  if (!count || end > bytes.length) throw new Error("Invalid AppleDouble metadata");
  const ids = new Set<number>();
  for (let n = 0; n < count; n++) {
    const id = bytes.readUInt32BE(26 + n * 12), offset = bytes.readUInt32BE(30 + n * 12), length = bytes.readUInt32BE(34 + n * 12);
    if (![2, 9].includes(id) || ids.has(id) || offset < end || offset + length > bytes.length || spans.some(([a, b]) => length && offset < b && offset + length > a)) throw new Error("Unsupported AppleDouble metadata");
    ids.add(id); spans.push([offset, offset + length]);
  }
}

/** Recognize only copyfile's bounded Mac metadata layout with an empty resource
 * fork. Finder info and optional ATTR records cover the complete member. The
 * caller must additionally prove an exact source-file pair and no real ._ path.
 * Format: apple-oss-distributions/copyfile copyfile.c, apple_double_header_t /
 * attr_header_t / attr_entry_t. Unknown layouts remain ordinary refused data. */
export function assertMacArchiveMetadata(bytes: Buffer) {
  const invalid = () => { throw new Error("Unsupported or malformed Mac AppleDouble metadata"); };
  if (bytes.length < 82 || bytes.length > 64 * 1024) invalid();
  assertAppleDoubleMetadata(bytes);
  if (bytes.subarray(8, 24).toString("ascii") !== "Mac OS X        " || bytes.readUInt16BE(24) !== 2
    || bytes.readUInt32BE(26) !== 9 || bytes.readUInt32BE(30) !== 50 || bytes.readUInt32BE(34) !== bytes.length - 50
    || bytes.readUInt32BE(38) !== 2 || bytes.readUInt32BE(42) !== bytes.length || bytes.readUInt32BE(46) !== 0) invalid();
  if (bytes.length === 82) return; // Finder info only.
  if (bytes.length < 120 || bytes.readUInt16BE(82) !== 0 || bytes.readUInt32BE(84) !== 0x41545452
    || bytes.readUInt32BE(92) !== bytes.length || bytes.subarray(104, 118).some(value => value !== 0)) invalid();
  const dataStart = bytes.readUInt32BE(96), dataLength = bytes.readUInt32BE(100), count = bytes.readUInt16BE(118);
  if (dataStart < 120 || dataStart > bytes.length || dataStart + dataLength !== bytes.length || count > 1024) invalid();
  const names = new Set<string>(), spans: Array<[number, number]> = []; let cursor = 120;
  for (let n = 0; n < count; n++) {
    if (cursor + 11 > dataStart) invalid();
    const offset = bytes.readUInt32BE(cursor), length = bytes.readUInt32BE(cursor + 4), nameLength = bytes[cursor + 10]!;
    const nameEnd = cursor + 11 + nameLength, next = (nameEnd + 3) & ~3;
    if (bytes.readUInt16BE(cursor + 8) !== 0 || nameLength < 2 || nameLength > 128 || next > dataStart
      || bytes[nameEnd - 1] !== 0 || bytes.subarray(cursor + 11, nameEnd - 1).includes(0)
      || bytes.subarray(nameEnd, next).some(value => value !== 0) || offset < dataStart || offset + length > bytes.length) invalid();
    let name: string;
    try { name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(cursor + 11, nameEnd - 1)); } catch { return invalid(); }
    if (names.has(name)) invalid(); names.add(name); spans.push([offset, offset + length]); cursor = next;
  }
  if (cursor !== dataStart) invalid();
  // No overlapping values or unclaimed trailing payload can be disguised as
  // metadata. Zero-length attributes still carry an exact in-range offset.
  let end = dataStart;
  for (const [start, stop] of spans.sort(([a, b], [c, d]) => a - c || b - d)) { if (start !== end) invalid(); end = stop; }
  if (end !== bytes.length) invalid();
}
