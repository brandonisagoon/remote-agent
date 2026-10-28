import { createServer, request, type IncomingMessage } from "node:http";
import { createConnection, type Socket } from "node:net";

/** Preserve a preview's original Host/Origin through an ephemeral SSH port.
 * The client listener independently rejects cross-origin and rebound hosts. */
export async function openPreviewProxy(remoteOrigin: string, tunnelPort: number) {
  const remote = new URL(remoteOrigin);
  if (remote.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(remote.hostname) || remote.username || remote.password) throw new Error("Expected a private preview origin");
  const sockets = new Set<Socket>();
  let origin = "";
  const allowed = (req: IncomingMessage) => req.headers.host === new URL(origin).host
    && (!req.headers.origin || req.headers.origin === origin)
    && req.headers["sec-fetch-site"] !== "cross-site"
    && !!req.url?.startsWith("/") && !req.url.startsWith("//");
  const headers = (req: IncomingMessage) => ({ ...req.headers, host: remote.host, ...(req.headers.origin ? { origin: remote.origin } : {}) });
  const track = (socket: Socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); return socket; };
  const server = createServer((req, res) => {
    if (!allowed(req)) { res.writeHead(403).end("Private preview origin required"); return; }
    const upstream = request({ hostname: "127.0.0.1", port: tunnelPort, method: req.method, path: req.url, headers: headers(req) }, (response) => {
      const responseHeaders = { ...response.headers };
      if (responseHeaders.location?.startsWith(remote.origin + "/")) responseHeaders.location = origin + responseHeaders.location.slice(remote.origin.length);
      res.writeHead(response.statusCode ?? 502, responseHeaders);
      response.pipe(res);
      response.on("error", () => res.destroy());
    });
    upstream.on("socket", track);
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502).end("Preview unavailable; reconnect to its owning machine"); else res.destroy(); });
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on("connection", track);
  server.on("upgrade", (req, client, head) => {
    if (!allowed(req) || req.headers.upgrade?.toLowerCase() !== "websocket") { client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
    const upstream = track(createConnection({ host: "127.0.0.1", port: tunnelPort }));
    upstream.once("connect", () => {
      const lines = Object.entries(headers(req)).flatMap(([key, value]) => value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((entry) => `${key}: ${entry}`));
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      client.pipe(upstream, { end: false });
      upstream.pipe(client, { end: false });
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("Could not bind preview listener"); }
  origin = `http://127.0.0.1:${address.port}`;
  return { origin, close() { for (const socket of sockets) socket.destroy(); server.close(); } };
}
