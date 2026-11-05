import { nativeTakeoverRoutes } from "./native-takeover.ts";
import { Hono } from "hono";

import type { AppEnv } from "../../middleware/context.ts";
import postLaunch from "./post.launch.ts";

const routes = new Hono<AppEnv>();
routes.route("/native-takeover", nativeTakeoverRoutes);
routes.route("/", postLaunch);

export default routes;
