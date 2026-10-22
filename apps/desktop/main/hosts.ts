import { existsSync, readFileSync } from "node:fs";
import { DesktopHostsSchema, type DesktopHosts, type DesktopHost, type DesktopHostStatus } from "../../../lib/desktop-host.ts";
import { HostTransport } from "./host-transport.ts";
import { MachineSessionsSchema, type DesktopRepositoryReference } from "../../../lib/desktop-sessions.ts";

export class DesktopHostManager {
  private transports = new Map<string, HostTransport>();
  private state: DesktopHosts;
  constructor(file: string) {
    this.state = existsSync(file) ? DesktopHostsSchema.parse(JSON.parse(readFileSync(file, "utf8"))) : { activeId: "local", hosts: [{ id: "local", name: "This Mac", kind: "local" }] };
  }
  list() { return structuredClone(this.state); }
  get(id: string): DesktopHost {
    const host = this.state.hosts.find((entry) => entry.id === id);
    if (!host) throw new Error("Unknown machine");
    return host;
  }
  request<T>(id: string, method: string, args: unknown[] = []) {
    return this.transport(id).request<T>(method, args);
  }
  private transport(id: string) {
    const host = this.get(id);
    if (host.kind !== "ssh") throw new Error("This machine does not use SSH");
    let transport = this.transports.get(id);
    if (!transport) { transport = new HostTransport(host); this.transports.set(id, transport); }
    return transport;
  }
  /** Each request names its owner; navigation never changes a transport's target. */
  async repositorySessions(id: string, reference: DesktopRepositoryReference) {
    return MachineSessionsSchema.parse(await this.transport(id).request("sessions:repository", [reference]));
  }
  async status(id: string): Promise<DesktopHostStatus> {
    try { return await this.request<DesktopHostStatus>(id, "host:status"); }
    catch (error) { return { connected: false, serverAvailable: false, detail: error instanceof Error ? error.message : String(error) }; }
  }
  close() { for (const transport of this.transports.values()) transport.close(); this.transports.clear(); }
}
