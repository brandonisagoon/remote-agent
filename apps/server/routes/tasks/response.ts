/** Read-only compatibility for already-pinned tooling. These fields are not
 * stored, accept no browser controller and never grant a takeover lease. */
export function taskResponse<T extends { id: string; phase: string; ownerPaused: boolean }>(task: T | null) {
  if (!task) return null;
  const paused = task.ownerPaused || task.phase === "closed";
  return { ...task, controlMode: paused ? "paused" : "agent", controllerId: paused ? `task-supervisor:${task.id}` : null };
}
