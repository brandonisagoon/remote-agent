import { request } from "node:http";

/** Owner-authenticated SSH reaches this user-only socket; no bearer leaves
 * the host and no unauthenticated TCP listener is created on the client. */
export function desktopControl<T>(socketPath: string, route: string, method = "GET", body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: route, method, headers: { "Content-Type": "application/json" }, timeout: 30_000 }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; if (text.length > 8_000_000) req.destroy(new Error("Response exceeds desktop limit")); });
      response.on("end", () => {
        try {
          const data = JSON.parse(text);
          if ((response.statusCode ?? 500) >= 400) return reject(new Error(data.error ?? `Host returned ${response.statusCode}`));
          resolve(data as T);
        } catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Host request timed out; inspect state before repeating an action")));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
