const pendingWrites = new Map<string, Promise<void>>();

export async function enqueueAgentIssueWrite<T>(
  sessionKey: string,
  write: () => Promise<T>,
): Promise<T> {
  const previous = pendingWrites.get(sessionKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  pendingWrites.set(sessionKey, tail);

  await previous.catch(() => undefined);
  try {
    return await write();
  } finally {
    release();
    if (pendingWrites.get(sessionKey) === tail) {
      pendingWrites.delete(sessionKey);
    }
  }
}
