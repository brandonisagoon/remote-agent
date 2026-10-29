// Runs the real control socket in its own server process, as in production,
// with a publication route that answers after a delay.
import { Hono } from "hono";
import { startControlSocket } from "../apps/server/control-socket.ts";

const [socketPath, delay] = process.argv.slice(2);
const app = new Hono();
app.post("/api/sessions/:sessionId/issue-update", async (c) => {
  await c.req.json();
  await Bun.sleep(Number(delay));
  return c.json({ published: true, sessionId: c.req.param("sessionId") });
});
await startControlSocket({ path: socketPath!, app });
console.log("ready");
