import { expect, test } from "bun:test";
import path from "node:path";
import { readFileSync } from "node:fs";

test("preview forwarding preserves host/origin and streams WebSockets with client origin checks", async () => {
  const received: Array<{ host: string | null; origin: string | null; body: string }> = [];
  const streamEvents: string[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req, server) {
      const expected = `127.0.0.1:${server.port}`;
      if (req.headers.get("host") !== expected) return new Response("Invalid host", { status: 403 });
      if (req.headers.get("origin") && req.headers.get("origin") !== `http://${expected}`) return new Response("Invalid origin", { status: 403 });
      if (new URL(req.url).pathname === "/stream") { streamEvents.push("upgrade"); return server.upgrade(req) ? undefined : new Response("Upgrade required", { status: 400 }); }
      if (new URL(req.url).pathname === "/redirect") return new Response(null, { status: 302, headers: { location: `http://${expected}/destination` } });
      received.push({ host: req.headers.get("host"), origin: req.headers.get("origin"), body: await req.text() });
      return new Response("private preview");
    },
    websocket: { message(socket, message) { streamEvents.push("upstream-message"); socket.send(message); } },
  });
  // Electron runs Node's HTTP upgrade implementation. Exercise that boundary
  // in Node rather than Bun's different node:http compatibility layer.
  const module = path.resolve("apps/desktop/main/preview-proxy.ts");
  const implementation = new Bun.Transpiler({ loader: "ts", target: "node" }).transformSync(readFileSync(module, "utf8"));
  const source = implementation + `\nconst proxy=await openPreviewProxy('http://127.0.0.1:${upstream.port}',${upstream.port}); console.log(proxy.origin); process.on('SIGTERM',()=>{proxy.close();process.exit(0)});`;
  const child = Bun.spawn(["node", "--input-type=module", "-e", source], { stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  const first = await reader.read();
  const proxy = { origin: new TextDecoder().decode(first.value).trim(), close() { child.kill(); } };
  try {
    const response = await fetch(proxy.origin, { method: "POST", headers: { origin: proxy.origin }, body: "owned input" });
    expect(await response.text()).toBe("private preview");
    expect(received).toEqual([{ host: `127.0.0.1:${upstream.port}`, origin: `http://127.0.0.1:${upstream.port}`, body: "owned input" }]);
    expect((await fetch(proxy.origin, { headers: { origin: "https://other.example" } })).status).toBe(403);
    expect((await fetch(proxy.origin, { headers: { host: "rebound.example" } })).status).toBe(403);
    expect((await fetch(proxy.origin, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect(received.length).toBe(1);
    expect((await fetch(proxy.origin + "/redirect", { redirect: "manual" })).headers.get("location")).toBe(proxy.origin + "/destination");
    // This repository also includes DOM types; select Bun's documented
    // constructor overload for adding an Origin to the test client.
    const BunSocket = WebSocket as unknown as { new(url: string, options: Bun.WebSocketOptions): WebSocket };
    const socket = new BunSocket(proxy.origin.replace("http:", "ws:") + "/stream", { headers: { origin: proxy.origin } });
    try {
      const echoed = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Stream timed out: ${streamEvents.join(", ")}`)), 3000);
        socket.onopen = () => { streamEvents.push("client-open"); socket.send("shared browser frame"); };
        socket.onmessage = (event) => { clearTimeout(timer); resolve(String(event.data)); };
        socket.onerror = () => { clearTimeout(timer); reject(new Error("Stream failed")); };
      });
      expect(echoed).toBe("shared browser frame");
    } finally { socket.close(); }
  } finally { proxy.close(); upstream.stop(true); }
});
