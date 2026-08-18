import { Hono } from "hono";

import type { AppEnv } from "../../middleware/context.ts";
import openBb from "./get.open-bb.ts";

const routes = new Hono<AppEnv>();

routes.route("/bb", openBb);

export default routes;
