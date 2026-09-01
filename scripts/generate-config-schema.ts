import { writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { ServiceFileSchema } from "../src/lib/config.ts";

const output = path.join(import.meta.dir, "..", "remote-agent.config.schema.json");
const schema = z.toJSONSchema(ServiceFileSchema, {
  target: "draft-7",
  unrepresentable: "any",
});
writeFileSync(output, `${JSON.stringify(schema, null, 2)}\n`);
