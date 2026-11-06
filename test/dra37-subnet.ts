/**
 * DRA-37 fixture subnet selection (pure, used by dra37-docker-guard.ts).
 *
 * The guard gives each fixture network an explicit /28 inside 10.249.0.0/16
 * because a shared engine's default address pools can be exhausted. The
 * candidate must not overlap ANY IPv4 subnet the engine reports, compared as
 * numeric CIDR intervals (so 10.0.0.0/8 or 10.249.0.0/17 block candidates
 * just like an equal /28). Inventory is read fail-closed: a failed list or
 * inspect, a list/inspect mismatch, or any malformed IPv4 subnet refuses
 * selection. IPv6 subnets cannot overlap an IPv4 candidate and are only
 * checked for basic shape. Nothing is ever cleared; engine config is never read
 * or changed beyond `network ls` / `network inspect`.
 */

export type Interval = { start: number; end: number };
export const FIXTURE_POOL = "10.249.0.0/16";
export const FIXTURE_PREFIX = 28;

/** Parse an IPv4 CIDR into its numeric interval (host bits masked). Throws on
 * anything malformed; returns "ipv6" for an IPv6 subnet. */
export function parseSubnet(text: string): Interval | "ipv6" {
  if (text.includes(":")) {
    if (!/^[0-9a-f:]+(?:%[\w.-]+)?\/(\d{1,3})$/i.test(text) || Number(text.split("/")[1]) > 128) throw new Error(`Malformed IPv6 subnet ${JSON.stringify(text)}`);
    return "ipv6";
  }
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(text);
  if (!match) throw new Error(`Malformed IPv4 subnet ${JSON.stringify(text)}`);
  const octets = match.slice(1, 5).map(Number), prefix = Number(match[5]);
  if (octets.some(value => value > 255) || prefix > 32) throw new Error(`Malformed IPv4 subnet ${JSON.stringify(text)}`);
  const address = octets.reduce((sum, value) => sum * 256 + value, 0);
  const size = 2 ** (32 - prefix), start = Math.floor(address / size) * size;
  return { start, end: start + size - 1 };
}

export const overlaps = (a: Interval, b: Interval) => a.start <= b.end && b.start <= a.end;
const format = (value: number) => [24, 16, 8, 0].map(shift => Math.floor(value / 2 ** shift) % 256).join(".");

/** First /28 in the fixture pool that overlaps no used IPv4 subnet, or null. */
export function selectFixtureSubnet(used: string[]): string | null {
  const blocked = used.map(parseSubnet).filter((value): value is Interval => value !== "ipv6");
  const pool = parseSubnet(FIXTURE_POOL) as Interval, size = 2 ** (32 - FIXTURE_PREFIX);
  for (let start = pool.start; start + size - 1 <= pool.end; start += size) {
    const candidate = { start, end: start + size - 1 };
    if (!blocked.some(interval => overlaps(candidate, interval))) return `${format(start)}/${FIXTURE_PREFIX}`;
  }
  return null;
}

export type Run = (args: string[]) => { code: number | null; stdout: string; stderr: string };

/** Every subnet of every engine network, read-only and fail-closed. */
export function readEngineSubnets(run: Run): string[] {
  const listed = run(["network", "ls", "-q", "--no-trunc"]);
  if (listed.code !== 0) throw new Error(`network ls failed (${listed.code}): ${listed.stderr.trim().slice(0, 300)}`);
  const ids = listed.stdout.split("\n").map(value => value.trim()).filter(Boolean);
  if (!ids.length) throw new Error("network ls returned no networks; the inventory is not trustworthy");
  for (const id of ids) if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`network ls returned a malformed ID ${JSON.stringify(id.slice(0, 80))}`);
  const inspected = run(["network", "inspect", "--format", "{{json .Id}}\t{{json .IPAM.Config}}", ...ids]);
  if (inspected.code !== 0) throw new Error(`network inspect failed (${inspected.code}): ${inspected.stderr.trim().slice(0, 300)}`);
  const lines = inspected.stdout.split("\n").filter(Boolean), seen = new Set<string>(), subnets: string[] = [];
  for (const line of lines) {
    const tab = line.indexOf("\t");
    if (tab < 0) throw new Error(`Malformed network inspect line ${JSON.stringify(line.slice(0, 200))}`);
    let id: unknown, config: unknown;
    try { id = JSON.parse(line.slice(0, tab)); config = JSON.parse(line.slice(tab + 1)); }
    catch { throw new Error(`Malformed network inspect line ${JSON.stringify(line.slice(0, 200))}`); }
    if (typeof id !== "string" || !ids.includes(id) || seen.has(id)) throw new Error(`Unexpected network inspect ID ${JSON.stringify(id)}`);
    seen.add(id);
    if (config === null) continue;
    if (!Array.isArray(config)) throw new Error(`Malformed IPAM config for network ${id}`);
    for (const entry of config) {
      if (!entry || typeof entry !== "object") throw new Error(`Malformed IPAM entry for network ${id}`);
      const subnet = (entry as { Subnet?: unknown }).Subnet;
      if (subnet === undefined || subnet === "") continue;
      if (typeof subnet !== "string") throw new Error(`Malformed IPAM subnet for network ${id}`);
      parseSubnet(subnet);
      subnets.push(subnet);
    }
  }
  if (seen.size !== ids.length) throw new Error(`network inspect described ${seen.size} of ${ids.length} listed networks`);
  return subnets;
}
