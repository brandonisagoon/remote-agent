import { spawn, type ChildProcess } from "node:child_process";
import { createServer, createConnection } from "node:net";
import type { SshDesktopHost } from "../../../lib/desktop-host.ts";
import { openPreviewProxy } from "./preview-proxy.ts";

const forwards = new Map<string, { child: ChildProcess; url: string; close(): void }>();
let generation = 0;
export function closePreviewForwards() { generation++; for (const value of forwards.values()) value.close(); forwards.clear(); }

export async function forwardPreview(host: SshDesktopHost, remoteUrl: string): Promise<string> {
  const startedGeneration = generation;
  const url = new URL(remoteUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.username || url.password) throw new Error("Only private task previews can be forwarded");
  const key = `${host.id}:${url.port || 80}`;
  const existing = forwards.get(key);
  if (existing) return new URL(url.pathname + url.search + url.hash, existing.url).href;
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer(); server.on("error", reject);
    server.listen(0, "127.0.0.1", () => { const address = server.address(); if (!address || typeof address === "string") return reject(new Error("Could not allocate preview port")); server.close(() => resolve(address.port)); });
  });
  const child = spawn("ssh", ["-N", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2", "-L", `127.0.0.1:${port}:127.0.0.1:${url.port || 80}`, host.sshHost], { stdio: "ignore" });
  let proxy: Awaited<ReturnType<typeof openPreviewProxy>> | undefined;
  let ended = false; child.on("error", () => { ended = true; }); child.on("exit", () => { ended = true; proxy?.close(); if (forwards.get(key)?.child === child) forwards.delete(key); });
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (generation !== startedGeneration) throw new Error("Selected machine changed while opening the preview");
      if (ended) throw new Error("SSH preview connection failed");
      const listening = await new Promise<boolean>((resolve) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("error", () => resolve(false));
      });
      if (listening) {
        proxy = await openPreviewProxy(url.origin, port);
        if (ended || generation !== startedGeneration) throw new Error("Preview connection changed while opening");
        forwards.set(key, { child, url: proxy.origin, close() { proxy?.close(); child.kill(); } });
        return new URL(url.pathname + url.search + url.hash, proxy.origin).href;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Preview connection timed out");
  } catch (error) { proxy?.close(); child.kill(); throw error; }
}
