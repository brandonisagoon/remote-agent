export {
  configureMachines,
  findMachine,
  getDefaultMachineId,
  getMachine,
  getMachines,
  MachineRecordSchema,
  MachineSchema,
} from "./registry.ts";
export type { Machine, MachineRecord } from "./registry.ts";
export { buildZedDeepLink } from "./zed-link.ts";
