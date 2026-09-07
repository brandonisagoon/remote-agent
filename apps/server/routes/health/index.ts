import { Hono } from "hono";

import type { AppEnv } from "../../middleware/context.ts";
import getHealth from "./get.health.ts";

const routes = new Hono<AppEnv>();

routes.route("/", getHealth);

export default routes;
