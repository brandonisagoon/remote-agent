import { describe, expect, test } from "bun:test";

import { testConfig } from "../../../test-support/config.ts";
import { acquireRuntimeOwnership } from "./runtime-owner.ts";

describe("runtime ownership", () => {
  test("allows only one owner for a database/acpx pair", () => {
    const nonce = crypto.randomUUID();
    const config = testConfig({
      databaseUrl: `file:/tmp/remote-agent-owner-${nonce}.sqlite`,
      acpxStateDir: `/tmp/remote-agent-owner-${nonce}-acpx`,
    });
    const owner = acquireRuntimeOwnership(config);
    try {
      expect(() => acquireRuntimeOwnership(config)).toThrow(
        "owns this database/acpx state",
      );
    } finally {
      owner.release();
    }
    const replacement = acquireRuntimeOwnership(config);
    replacement.release();
  });
});
