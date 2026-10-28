import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SshDesktopHost } from "../../../lib/desktop-host.ts";

export function shellArgument(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
export function hostCommand(host: SshDesktopHost) {
  return [host.executable, `${host.runtimePath}/management/desktop-bridge.ts`, host.configPath, host.machineId, host.serviceLabel ?? ""].map(shellArgument).join(" ");
}

const responseSchema = z.object({ id: z.string(), result: z.unknown().optional(), error: z.string().optional() }).strict();
export class HostTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(readonly host: SshDesktopHost) {}

  close() {
    const child = this.child;
    this.child = null;
    child?.stdin.end();
    child?.kill();
    this.rejectPending("Connection closed. Work continues on the host; inspect state before repeating an action.");
  }
  private rejectPending(message: string) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.pending.clear();
  }
  private connect() {
    if (this.child) return this.child;
    const child = spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2", this.host.sshHost, hostCommand(this.host)], { stdio: "pipe" });
    this.child = child;
    let diagnostic = "";
    child.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk.toString()).slice(-2000); });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (this.child !== child) return;
      try {
        const response = responseSchema.parse(JSON.parse(line));
        const pending = this.pending.get(response.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(response.id);
        if (response.error) pending.reject(new Error(response.error)); else pending.resolve(response.result);
      } catch { this.close(); }
    });
    const disconnected = () => {
      if (this.child !== child) return;
      this.child = null;
      this.rejectPending(`Could not reach ${this.host.name}. ${diagnostic.trim() || "SSH disconnected."} Work continues there; inspect state before repeating an action.`);
    };
    child.on("error", disconnected); child.on("close", disconnected);
    child.stdin.on("error", disconnected);
    return child;
  }
  request<T>(method: string, args: unknown[] = []): Promise<T> {
    const child = this.connect();
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("The host did not acknowledge this request. Inspect its state before repeating an action.")); this.close(); }, 60_000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      child.stdin.write(JSON.stringify({ id, method, args }) + "\n", (error) => { if (error) this.close(); });
    });
  }
}
