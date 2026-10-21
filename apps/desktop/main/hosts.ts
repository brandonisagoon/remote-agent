import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DesktopHostsSchema, type DesktopHosts, type DesktopHost, type DesktopHostStatus } from "../../../lib/desktop-host.ts";
import { HostTransport } from "./host-transport.ts";

export class DesktopHostManager {
  private transport: HostTransport | null = null;
  private state: DesktopHosts;
  private switching = false;
  constructor(private file: string) {
    this.state = existsSync(file) ? DesktopHostsSchema.parse(JSON.parse(readFileSync(file, "utf8"))) : { activeId: "local", hosts: [{ id: "local", name: "This Mac", kind: "local" }] };
  }
  list() { return structuredClone(this.state); }
  selected(): DesktopHost { return this.state.hosts.find((host) => host.id === this.state.activeId)!; }
  assertSelected(id: string) { if (this.switching || this.state.activeId !== id) throw new Error("The selected machine changed. Reload before continuing."); }
  request<T>(id: string, method: string, args: unknown[] = []) {
    this.assertSelected(id);
    const host = this.selected();
    if (host.kind !== "ssh") throw new Error("This machine does not use SSH");
    this.transport ??= new HostTransport(host);
    return this.transport.request<T>(method, args);
  }
  async status(id: string): Promise<DesktopHostStatus> {
    try { return await this.request<DesktopHostStatus>(id, "host:status"); }
    catch (error) { return { connected: false, serverAvailable: false, detail: error instanceof Error ? error.message : String(error) }; }
  }
  select(expectedId: string, id: string) {
    this.assertSelected(expectedId);
    if (!this.state.hosts.some((host) => host.id === id)) throw new Error("Unknown machine");
    this.switching = true;
    try {
      const next = { ...this.state, activeId: id };
      const temporary = path.join(path.dirname(this.file), `.hosts-${randomUUID()}.tmp`);
      writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 }); renameSync(temporary, this.file);
      this.transport?.close(); this.transport = null; this.state = next;
      return this.list();
    } finally { this.switching = false; }
  }
  close() { this.transport?.close(); this.transport = null; }
}
