import { useSyncExternalStore } from "react";

export type RepositoryTab = "sessions" | "settings" | "skillsets";

/** The active tab lives outside the page so the header (tabs) and the page
    (content) stay in sync; remembered per repository. */
const tabs = new Map<string, RepositoryTab>();
const listeners = new Set<() => void>();

export function setRepositoryTab(repositoryId: string, tab: RepositoryTab): void {
  tabs.set(repositoryId, tab);
  for (const listener of listeners) listener();
}

export function useRepositoryTab(repositoryId: string): RepositoryTab {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => tabs.get(repositoryId) ?? "sessions",
  );
}
