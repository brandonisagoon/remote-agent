import { Hono } from "hono";

import type { AppEnv } from "../../middleware/context.ts";
import postLinear from "./post.linear.ts";

const routes = new Hono<AppEnv>();

routes.route("/:webhookId", postLinear);

export default routes;
