import { expect, test } from "bun:test";
import { createTestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createAcpxSessionRuntime } from "./session-runtime.ts";

test("the installed acpx adapter cannot claim native steering from its ignored mode flag", async () => {
  const db = await createTestDatabase();
  try {
    const runtime = createAcpxSessionRuntime(db.prisma, testConfig());
    let claimed = false;
    expect(runtime.steer).toBeDefined();
    const result = await runtime.steer!({ sessionId: "existing", requestId: "steer", targetRequestId: "active", text: "Change direction",
      beforeSend: async () => { claimed = true; return true; } });
    expect(result.status).toBe("unsupported"); expect(claimed).toBe(false);
    expect(await db.prisma.runtimeSession.count()).toBe(0);
  } finally { await db.cleanup(); }
});
