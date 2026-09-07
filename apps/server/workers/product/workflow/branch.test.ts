import { describe, expect, test } from "bun:test";

import { isSafeBranchName, renderBranchName, renderWorktreeName } from "./branch.ts";

describe("renderBranchName", () => {
  test("the default template passes the provider's name through", () => {
    expect(
      renderBranchName("{branch}", {
        branch: "brandon/cube-42-fix-flaky-test",
        issue: "CUBE-42",
        title: "Fix the flaky test",
      }),
    ).toBe("brandon/cube-42-fix-flaky-test");
  });

  test("templates compose provider facts", () => {
    const rendered = renderBranchName("agent/{issue}-{title}", {
      branch: null,
      issue: "CUBE-42",
      title: "Fix the flaky test!",
    });
    expect(rendered).toBe("agent/cube-42-fix-the-flaky-test");
    expect(isSafeBranchName(rendered!)).toBeTrue();
  });

  test("an empty render returns null instead of a broken name", () => {
    expect(
      renderBranchName("{branch}", { branch: null, issue: "CUBE-42" }),
    ).toBeNull();
  });

  test("empty placeholders never leave dangling separators", () => {
    expect(
      renderBranchName("agent/{issue}-{title}", { branch: null, issue: "CUBE-42", title: "" }),
    ).toBe("agent/cube-42");
  });
});

describe("renderWorktreeName", () => {
  test("the default flattens the provider's suggested branch", () => {
    expect(
      renderWorktreeName(
        "{branch}",
        { branch: "brandon/cube-42-fix", issue: "CUBE-42" },
        "brandon/cube-42-fix",
      ),
    ).toBe("brandon-cube-42-fix");
  });

  test("a short template makes short directories", () => {
    expect(
      renderWorktreeName(
        "{issue}",
        { branch: "brandon/cube-42-fix", issue: "CUBE-42" },
        "brandon/cube-42-fix",
      ),
    ).toBe("cube-42");
  });

  test("template literals pass through untouched", () => {
    expect(
      renderWorktreeName(
        "agents/{issue}",
        { branch: null, issue: "CUBE-42" },
        "agent/cube-42",
      ),
    ).toBe("agents/cube-42");
  });

  test("an empty render falls back to the flattened session branch", () => {
    expect(
      renderWorktreeName(
        "{title}",
        { branch: null, issue: "CUBE-42", title: "" },
        "agent/cube-42",
      ),
    ).toBe("agent-cube-42");
  });
});
