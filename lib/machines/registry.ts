import { z } from "zod";

export const MachineSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: "must use lowercase kebab-case",
  });

export type Machine = z.infer<typeof MachineSchema>;

export const MachineRecordSchema = z.object({
  id: MachineSchema,
  label: z.string().trim().min(1),
  acceptsTrackerInput: z.boolean(),
  default: z.boolean(),
});

export type MachineRecord = z.infer<typeof MachineRecordSchema>;

const MachineRecordsSchema = z
  .array(MachineRecordSchema)
  .min(1)
  .superRefine((records, context) => {
    for (const field of ["id", "label"] as const) {
      const seen = new Set<string>();
      for (const [index, record] of records.entries()) {
        if (seen.has(record[field])) {
          context.addIssue({
            code: "custom",
            path: [index, field],
            message: `${field} must be unique`,
          });
        }
        seen.add(record[field]);
      }
    }
    if (records.filter((record) => record.default).length !== 1) {
      context.addIssue({
        code: "custom",
        message: "hosts must contain exactly one default",
      });
    }
  });

let machines: readonly MachineRecord[] | null = null;

/** Configure the process-wide host registry once service config is loaded. */
export function configureMachines(input: unknown): readonly MachineRecord[] {
  machines = Object.freeze(
    MachineRecordsSchema.parse(input).map((record) => Object.freeze(record)),
  );
  return machines;
}

export function getMachines(): readonly MachineRecord[] {
  if (!machines) throw new Error("machine registry is not configured");
  return machines;
}

export function getDefaultMachineId(): Machine {
  return getMachines().find((machine) => machine.default)!.id;
}

export function getMachine(query: { id: Machine }): MachineRecord {
  const machine = getMachines().find((entry) => entry.id === query.id);
  if (!machine) throw new Error(`unknown machine: ${query.id}`);
  return machine;
}

export function findMachine(query: {
  trackerLabels: Iterable<string>;
}): MachineRecord | null {
  const labels = new Set(query.trackerLabels);
  return getMachines().find((machine) => labels.has(machine.label)) ?? null;
}
