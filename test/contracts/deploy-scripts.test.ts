import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { repoRoot } from "../../src/test-support/repo.ts";

const REMOTE_AGENT = repoRoot();

describe("remote-agent deployment scripts", () => {
  test("loads the configured branch before resolving the deploy target", () => {
    const script = readFileSync(
      path.join(REMOTE_AGENT, "scripts/deploy.sh"),
      "utf8",
    );
    const environmentIndex = script.indexOf(
      '[ -f "$STATE/remote-agent.env" ]',
    );
    const branchIndex = script.indexOf(
      'BRANCH="${REMOTE_AGENT_DEPLOY_BRANCH:-main}"',
    );

    expect(environmentIndex).toBeGreaterThan(-1);
    expect(branchIndex).toBeGreaterThan(environmentIndex);
  });

  test("refreshes an existing deployment clone to the selected branch", () => {
    const script = readFileSync(
      path.join(REMOTE_AGENT, "scripts/install.sh"),
      "utf8",
    );

    expect(script).toContain(
      'git -C "$REPO" reset --hard --quiet "origin/$BRANCH"',
    );
    expect(script).toContain(
      '"refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"',
    );
    expect(script).toContain('git clone --quiet --depth=1 --branch "$BRANCH"');
    expect(script).not.toContain("sparse-checkout");
    expect(script).not.toContain("apps/remote-agent");
  });

  test("derives install paths and launchd labels from the service name", () => {
    const install = readFileSync(
      path.join(REMOTE_AGENT, "scripts/install.sh"),
      "utf8",
    );
    const deploy = readFileSync(
      path.join(REMOTE_AGENT, "scripts/deploy.sh"),
      "utf8",
    );

    for (const script of [install, deploy]) {
      expect(script).toContain("SERVICE_NAME=");
      expect(script).not.toContain("dev.cubicsurveys");
      expect(script).not.toContain("cubic-remote-agent");
    }
    expect(install).toContain('REMOTE_AGENT_ENV_FILE must point to a secrets env file');
    expect(install).toContain('"$REPO/" "$APP/"');
  });

  test("typechecks only production sources during deployment", () => {
    const script = readFileSync(
      path.join(REMOTE_AGENT, "scripts/deploy.sh"),
      "utf8",
    );
    const config = readFileSync(
      path.join(REMOTE_AGENT, "tsconfig.deploy.json"),
      "utf8",
    );

    expect(script).toContain("bunx tsc --noEmit -p tsconfig.deploy.json");
    expect(script).toContain(
      'git fetch --quiet origin "refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"',
    );
    expect(JSON.parse(config).exclude).toContain("**/*.test.ts");
  });
});
