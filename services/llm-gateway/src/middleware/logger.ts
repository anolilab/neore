import { createMiddleware } from "hono/factory";

import type { HonoEnv } from "../env.js";
import { logger } from "../lib/logger.js";

const loggerMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
    const start = Date.now();
    const { method } = c.req;
    const path = new URL(c.req.url).pathname;

    await next();

    const duration = Date.now() - start;
    const { status } = c.res;
    const requestId = c.get("requestId") ?? "-";

    if (status >= 500) {
        logger.error({ duration, method, path, requestId, status });
    } else if (status >= 400) {
        logger.warn({ duration, method, path, requestId, status });
    } else {
        logger.info({ duration, method, path, requestId, status });
    }
});

export default loggerMiddleware;
