import { Hono } from "hono";

import type { AppEnv } from "../../middleware/context.ts";
import postGithub from "./post.github.ts";
import postLinear from "./post.linear.ts";

const routes = new Hono<AppEnv>();

routes.route("/github", postGithub);
routes.route("/:webhookId", postLinear);

export default routes;
