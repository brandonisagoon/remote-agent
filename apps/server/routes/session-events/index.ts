import { Hono } from "hono";

import type { AppEnv } from "../../middleware/context.ts";
import postSessionEvents from "./post.session-events.ts";

const routes = new Hono<AppEnv>();

routes.route("/", postSessionEvents);

export default routes;
