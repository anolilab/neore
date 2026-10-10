import { createPail } from "@visulima/pail";
import { createMiddleware } from "hono/factory";

import type { AppEnv } from "../index.js";

const logger = createPail();

const loggerMiddleware = createMiddleware<{ Bindings: AppEnv }>(async (c, next) => {
    const start = Date.now();
    const { method } = c.req;
    const path = new URL(c.req.url).pathname;

    await next();

    const duration = Date.now() - start;
    const { status } = c.res;
    const requestId = (c.get("requestId" as never) as string | undefined) ?? "-";

    if (status >= 500) {
        logger.error({ duration, method, path, requestId, status });
    } else if (status >= 400) {
        logger.warn({ duration, method, path, requestId, status });
    } else {
        logger.info({ duration, method, path, requestId, status });
    }
});

export default loggerMiddleware;
