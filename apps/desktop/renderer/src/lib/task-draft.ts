import { useState } from "react";
import { useHost } from "./host-context.tsx";

interface TaskDraft { text: string; requestKey?: string }

/** Keep unsent text and retry identities across task selection and renderer
 * reloads. Each machine owns a separate namespace in this window's session. */
export function useTaskDraft(key: string) {
  const { host } = useHost();
  const storageKey = `task-draft:${host.id}:${key}`;
  const [draft, setValue] = useState<TaskDraft>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
      if (saved && typeof saved.text === "string" && (!saved.requestKey || typeof saved.requestKey === "string")) return saved;
    } catch { /* A malformed draft must not prevent the session from opening. */ }
    return { text: "" };
  });
  const setDraft = (value: TaskDraft) => {
    if (value.text) sessionStorage.setItem(storageKey, JSON.stringify(value));
    else sessionStorage.removeItem(storageKey);
    setValue(value);
  };
  return { draft, setDraft };
}
