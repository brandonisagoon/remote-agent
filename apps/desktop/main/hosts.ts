import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DesktopHostsSchema, type DesktopHosts, type DesktopHost, type DesktopHostStatus } from "../../../lib/desktop-host.ts";
import { HostTransport } from "./host-transport.ts";
import { MachineSessionsSchema, type DesktopRepositoryReference } from "../../../lib/desktop-sessions.ts";

export class DesktopHostManager {
  private transports = new Map<string, HostTransport>();
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
    return this.transport(id).request<T>(method, args);
  }
  private transport(id: string) {
    const host = this.state.hosts.find((entry) => entry.id === id);
    if (!host) throw new Error("Unknown machine");
    if (host.kind !== "ssh") throw new Error("This machine does not use SSH");
    let transport = this.transports.get(id);
    if (!transport) { transport = new HostTransport(host); this.transports.set(id, transport); }
    return transport;
  }
  /** Cross-machine access is read-only and restricted to the session table. */
  async repositorySessions(id: string, reference: DesktopRepositoryReference) {
    return MachineSessionsSchema.parse(await this.transport(id).request("sessions:repository", [reference]));
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
      this.close(); this.state = next;
      return this.list();
    } finally { this.switching = false; }
  }
  close() { for (const transport of this.transports.values()) transport.close(); this.transports.clear(); }
}
