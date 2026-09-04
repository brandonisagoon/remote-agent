import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { serviceLabel } from "../../src/management/supervisor/index.ts";
import { repoRoot } from "../../src/test-support/repo.ts";

const REMOTE_AGENT = repoRoot();
const deploySource = readFileSync(path.join(REMOTE_AGENT, "src/management/deploy.ts"), "utf8");
const provisionSource = readFileSync(path.join(REMOTE_AGENT, "src/management/provision.ts"), "utf8");

describe("remote-agent deployment modules", () => {
  test("the bash scripts are gone — deployment is TypeScript only", () => {
    expect(existsSync(path.join(REMOTE_AGENT, "scripts/deploy.sh"))).toBeFalse();
    expect(existsSync(path.join(REMOTE_AGENT, "scripts/install.sh"))).toBeFalse();
  });

  test("refreshes an existing deployment clone to the selected branch", () => {
    for (const source of [deploySource, provisionSource]) {
      expect(source).toContain("refs/heads/${branch}:refs/remotes/origin/${branch}");
      expect(source).toContain('"reset", "--hard", "--quiet"');
    }
    expect(provisionSource).toContain('"clone", "--quiet", "--depth=1", "--branch"');
    expect(provisionSource).not.toContain("sparse-checkout");
  });

  test("derives supervisor labels from the service name", () => {
    expect(serviceLabel("example-agent")).toBe("dev.example-agent.service");
    for (const source of [deploySource, provisionSource]) {
      expect(source).not.toContain("dev.cubicsurveys");
      expect(source).not.toContain("cubic-remote-agent");
    }
  });

  test("migrates with the service stopped and snapshots the database first", () => {
    const stopIndex = deploySource.indexOf("supervisor().stop(");
    const snapshotIndex = deploySource.indexOf("snapshotDatabase(");
    const migrateIndex = deploySource.indexOf('"prisma", "migrate", "deploy"');
    expect(stopIndex).toBeGreaterThan(-1);
    expect(snapshotIndex).toBeGreaterThan(stopIndex);
    expect(migrateIndex).toBeGreaterThan(snapshotIndex);
  });

  test("typechecks only production sources during deployment", () => {
    const config = readFileSync(path.join(REMOTE_AGENT, "tsconfig.deploy.json"), "utf8");
    expect(deploySource).toContain('"tsc", "--noEmit", "-p", "tsconfig.deploy.json"');
    expect(JSON.parse(config).exclude).toContain("**/*.test.ts");
  });
});
