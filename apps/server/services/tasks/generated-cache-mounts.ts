import path from "node:path";
import { readFile } from "node:fs/promises";
import { executeOwnedObserver } from "./cleanup-resource-observer.ts";
export function cacheMountpoints(text: string, platform: string): string[] {
  if (!text || Buffer.byteLength(text) > 2 * 1024 * 1024) throw Error("Native mount inventory is unavailable or oversized");
  const decode = (value: string) => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
  const result = text.trimEnd().split("\n").map(line => {
    let value: string;
    if (platform === "darwin") {
      const match = /^.+ on (\/.*) \([^\n]+\)$/.exec(line);
      if (!match || line.split(" on ").length !== 2) throw Error("Native mount inventory is ambiguous");
      value = match[1]!;
    } else if (platform === "linux") {
      const fields = line.split(" "), separator = fields.indexOf("-");
      if (separator < 6 || fields.length < separator + 4 || !/^\d+$/.test(fields[0]!)) throw Error("Native mount inventory is incomplete");
      value = fields[4]!;
    } else throw Error("Native mount inventory is unsupported");
    value = decode(value);
    if (!path.isAbsolute(value) || path.normalize(value) !== value || value.includes("\0") || /\\/.test(value)) throw Error("Native mount path is ambiguous");
    return value;
  });
  if (!result.includes("/")) throw Error("Native mount inventory has no root");
  return result;
}
export async function assertGeneratedCacheMounts(roots: string[]) {
  const text = process.platform === "darwin"
    ? await executeOwnedObserver(["/sbin/mount"], { cwd: "/", timeoutMs: 5000 })
    : process.platform === "linux" ? await readFile("/proc/self/mountinfo", "utf8") : "";
  if (cacheMountpoints(text, process.platform).some(mount => roots.some(root => mount === root || mount.startsWith(root + path.sep)))) throw Error("Generated source has a nested mount or bind alias");
}
