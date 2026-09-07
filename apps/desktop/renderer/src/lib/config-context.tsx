import { createContext, useContext } from "react";

import type { RepoConfig, ServiceFile } from "../../../../../lib/config.ts";
import type { Mutate } from "@renderer/lib/types.ts";

/** One repository's committed-config slice of the draft. Sections receive
    this so they stay ignorant of the document plumbing. */
export interface RepoConfigDraft {
  config: RepoConfig | null;
  /** Parse error for an invalid committed file (fix it in an editor). */
  error: string | null;
  path: string | null;
  mutate(change: (config: RepoConfig) => void): void;
}

export interface ConfigDraft {
  draft: ServiceFile;
  mutate: Mutate;
  /** Draft views over every repository's committed .remote-agent.config.json.
      Edits join the same dirty/save/revert flow as the app config. */
  repoConfig(id: string): RepoConfigDraft;
  save(): Promise<void>;
  /** Apply a change and write it to disk immediately (no unsaved state). */
  commit(change: (value: ServiceFile) => void): Promise<void>;
  /** Discard draft edits and re-adopt the files. */
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
