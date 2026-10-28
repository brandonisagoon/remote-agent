import { Hono } from "hono";
import type { AppEnv } from "../../middleware/context.ts";
import labels from "./labels.ts";
import delegates from "./delegates.ts";

export default new Hono<AppEnv>().route("/", labels).route("/", delegates);
