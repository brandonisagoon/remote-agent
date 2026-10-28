import { request } from "node:http";

/** Owner-authenticated SSH reaches this user-only socket; no bearer leaves
 * the host and no unauthenticated TCP listener is created on the client. */
export function desktopControl<T>(socketPath: string, route: string, method = "GET", body?: unknown, timeoutMs = 30_000): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    return Promise.reject(new Error("Control request timeout must be a finite positive timer duration"));
  }
  return new Promise((resolve, reject) => {
    // Serialize before allocating a request/timer so invalid bodies cannot
    // leave a live socket behind. Never retry writes on an uncertain response.
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error !== undefined) reject(error);
      else resolve(value as T);
    };
    const req = request({ socketPath, path: route, method, headers: { "Content-Type": "application/json" } }, (response) => {
      let text = "";
      let bytes = 0;
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 8_000_000) {
          const error = new Error("Response exceeds desktop limit");
          finish(error);
          req.destroy(error);
          return;
        }
        text += chunk;
      });
      response.on("error", (error) => finish(error));
      response.on("aborted", () => finish(new Error("Control response interrupted; inspect state before repeating an action")));
      response.on("end", () => {
        try {
          const data = JSON.parse(text);
          if ((response.statusCode ?? 500) >= 400) return finish(new Error(data?.error ?? `Host returned ${response.statusCode}`));
          finish(undefined, data as T);
        } catch (error) { finish(error); }
      });
    });
    // Socket inactivity timeouts do not bound connection/response lifetime:
    // a trickling response can keep them alive forever. Use one total deadline.
    const deadline = setTimeout(() => {
      const error = new Error("Host request timed out; inspect state before repeating an action");
      finish(error);
      req.destroy(error);
    }, timeoutMs);
    req.on("error", (error) => finish(error));
    try { req.end(payload); } catch (error) {
      finish(error);
      req.destroy();
    }
  });
}
