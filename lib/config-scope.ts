import { AsyncLocalStorage } from "node:async_hooks";

/** A desktop request keeps its config through async work, independent of navigation. */
const configScope = new AsyncLocalStorage<string>();

export function scopedConfigFile(): string | undefined {
  return configScope.getStore();
}

export function withConfigFile<T>(file: string, action: () => T): T {
  return configScope.run(file, action);
}
