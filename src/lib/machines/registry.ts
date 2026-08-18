import { z } from "zod";

const MACHINE_IDS = ["macbook-air", "macbook-pro"] as const;

export const MachineSchema = z.enum(MACHINE_IDS);

export type Machine = z.infer<typeof MachineSchema>;

export interface MachineRecord {
  id: Machine;
  linearLabel: string;
  zedConnection: "local" | "ssh";
  acceptsLinearInput: boolean;
}

export const DEFAULT_MACHINE_ID: Machine = "macbook-air";

const MACHINES: Readonly<Record<Machine, MachineRecord>> = {
  "macbook-air": {
    id: "macbook-air",
    linearLabel: "Brandon's MacBook Air",
    zedConnection: "ssh",
    acceptsLinearInput: true,
  },
  "macbook-pro": {
    id: "macbook-pro",
    linearLabel: "Brandon's MacBook Pro",
    zedConnection: "local",
    acceptsLinearInput: false,
  },
};

export function getMachines(): readonly MachineRecord[] {
  return Object.values(MACHINES);
}

export function getMachine(query: { id: Machine }): MachineRecord {
  return MACHINES[query.id];
}

export function findMachine(query: {
  linearLabels: Iterable<string>;
}): MachineRecord | null {
  const labels = new Set(query.linearLabels);
  return (
    getMachines().find((machine) => labels.has(machine.linearLabel)) ?? null
  );
}
