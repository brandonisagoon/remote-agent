import { writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { RepoConfigSchema, ServiceFileSchema } from "../lib/config.ts";

function emit(name: string, schema: z.ZodType): void {
  const output = path.join(import.meta.dir, "..", name);
  const json = z.toJSONSchema(schema, {
    target: "draft-7",
    unrepresentable: "any",
  });
  writeFileSync(output, `${JSON.stringify(json, null, 2)}\n`);
}

emit("remote-agent.config.schema.json", ServiceFileSchema);
emit("remote-agent.repo-config.schema.json", RepoConfigSchema);
