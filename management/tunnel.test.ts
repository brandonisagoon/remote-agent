import { describe, expect, test } from "bun:test";

import { tunnelDefinition, tunnelHost, tunnelLabel } from "./tunnel.ts";

describe("tunnel", () => {
  test("the hostname is the public URL's host", () => {
    expect(tunnelHost({ publicUrl: "https://agents.example.com" })).toBe("agents.example.com");
    expect(tunnelHost({ publicUrl: "https://agents.example.com/" })).toBe("agents.example.com");
  });

  test("the runner is a supervised service beside the server, ingress via --url", () => {
    const definition = tunnelDefinition({
      serviceName: "example-agent",
      cloudflared: "/opt/homebrew/bin/cloudflared",
      name: "example-agent",
      port: 9000,
      logFile: "/tmp/tunnel.log",
    });
    expect(definition.label).toBe("dev.example-agent.service.tunnel");
    expect(definition.command).toEqual([
      "/opt/homebrew/bin/cloudflared",
      "tunnel",
      "--no-autoupdate",
      "--url",
      "http://127.0.0.1:9000",
      "run",
      "example-agent",
    ]);
    expect(tunnelLabel("example-agent")).toBe(definition.label);
  });
});
