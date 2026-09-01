import { beforeEach, describe, expect, test } from "bun:test";

import {
  configureMachines,
  findMachine,
  getDefaultMachineId,
  getMachine,
  getMachines,
  MachineSchema,
} from "./index.ts";

const HOSTS = [
  {
    id: "studio-mac",
    label: "Studio Mac",
    zedConnection: "local" as const,
    acceptsTrackerInput: true,
    default: true,
  },
  {
    id: "build-mac",
    label: "Build Mac",
    zedConnection: "ssh" as const,
    acceptsTrackerInput: false,
    default: false,
  },
];

beforeEach(() => configureMachines(HOSTS));

describe("machine registry", () => {
  test("accepts arbitrary kebab-case machine ids", () => {
    expect(MachineSchema.parse("studio-mac")).toBe("studio-mac");
    expect(MachineSchema.safeParse("Studio Mac").success).toBe(false);
  });

  test("owns tracker labels, capabilities, and the default", () => {
    expect(getMachines()).toHaveLength(2);
    expect(getDefaultMachineId()).toBe("studio-mac");
    expect(getMachine({ id: "studio-mac" })).toEqual(HOSTS[0]);
    expect(findMachine({ trackerLabels: ["Build Mac"] })?.id).toBe(
      "build-mac",
    );
  });

  test("rejects duplicate fields and ambiguous defaults", () => {
    expect(() =>
      configureMachines([
        HOSTS[0],
        { ...HOSTS[1], id: "studio-mac", default: true },
      ]),
    ).toThrow();
  });

  test("fails closed for unknown machines and labels", () => {
    expect(() => getMachine({ id: "unknown" })).toThrow("unknown machine");
    expect(findMachine({ trackerLabels: ["Codex"] })).toBeNull();
  });
});
