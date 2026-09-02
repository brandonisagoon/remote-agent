import { createContext, useContext } from "react";

import type { ServiceFile } from "../../../../lib/config.ts";
import type { Mutate } from "@renderer/lib/types.ts";

export interface ConfigDraft {
  draft: ServiceFile;
  mutate: Mutate;
  save(): Promise<void>;
  /** Apply a change and write it to disk immediately (no unsaved state). */
  commit(change: (value: ServiceFile) => void): Promise<void>;
  /** Discard draft edits and re-adopt the file. */
  revert(): void;
  dirty: boolean;
}

const ConfigContext = createContext<ConfigDraft | null>(null);

export const ConfigProvider = ConfigContext.Provider;

/** The valid, editable config draft. Only available under the router (App gates on validity). */
export function useConfig(): ConfigDraft {
  const value = useContext(ConfigContext);
  if (!value) throw new Error("useConfig must be used inside ConfigProvider");
  return value;
}
