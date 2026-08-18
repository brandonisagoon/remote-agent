import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MACHINE_ID,
  findMachine,
  getMachine,
  getMachines,
  MachineSchema,
} from "./index.ts";

describe("machine registry", () => {
  test("defines every supported machine exactly once", () => {
    expect(getMachines().map((machine) => machine.id)).toEqual(
      MachineSchema.options,
    );
  });

  test("owns Linear labels and machine capabilities", () => {
    expect(getMachine({ id: DEFAULT_MACHINE_ID })).toEqual({
      id: "macbook-air",
      linearLabel: "Brandon's MacBook Air",
      zedConnection: "ssh",
      acceptsLinearInput: true,
    });
    expect(
      findMachine({ linearLabels: ["Brandon's MacBook Pro"] })?.id,
    ).toBe("macbook-pro");
  });

  test("returns null when labels do not identify a machine", () => {
    expect(findMachine({ linearLabels: ["Codex"] })).toBeNull();
  });
});
