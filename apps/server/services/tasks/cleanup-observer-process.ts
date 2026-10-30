/** Internal transport helper. Its parent starts it in a new POSIX session.
 * Keep the group leader alive until all command pipes drain or the operation
 * is cancelled, so cleanup never addresses a recycled numeric process group. */
function finish(): never {
  try { process.kill(-process.pid, "SIGKILL"); } catch { /* No group was created. */ }
  process.exit(1);
}

async function forward(stream: ReadableStream<Uint8Array>, output: Bun.BunFile) {
  const reader = stream.getReader(), writer = output.writer();
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      writer.write(next.value); await writer.flush();
    }
    await writer.flush();
  } finally { reader.releaseLock(); }
}

if (import.meta.main) {
  const timeoutMs = Number(process.argv[2]);
  const command = process.argv.slice(3);
  if (!process.send || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 || !command.length
    || !["darwin", "linux"].includes(process.platform)) process.exit(1);
  process.on("message", finish);
  process.on("disconnect", finish);
  process.on("SIGTERM", finish);
  process.on("SIGINT", finish);
  process.on("SIGHUP", finish);
  process.on("uncaughtException", finish);
  process.on("unhandledRejection", finish);
  // This independent deadline also handles a parent lost before cancellation.
  setTimeout(finish, timeoutMs);
  setInterval(() => {}, 1000);
  try {
    const child = Bun.spawn(command, { stdin: "inherit", stdout: "pipe", stderr: "pipe" });
    // Completion includes EOF from descendants that inherited either pipe.
    // The server bounds the forwarded bytes; this helper never parses output.
    const [, , code] = await Promise.all([forward(child.stdout, Bun.stdout), forward(child.stderr, Bun.stderr), child.exited]);
    process.send({ version: 1, code });
  } catch { finish(); }
}
