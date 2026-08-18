import { existsSync } from "node:fs";
import path from "node:path";

export function repoRoot(startDirectory: string = import.meta.dir): string {
  let current = path.resolve(startDirectory);

  while (true) {
    if (
      existsSync(path.join(current, "bun.lock")) ||
      existsSync(path.join(current, ".git"))
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Repository root not found from ${startDirectory}`);
    }
    current = parent;
  }
}
