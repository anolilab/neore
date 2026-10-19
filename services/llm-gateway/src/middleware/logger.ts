import { createMiddleware } from "hono/factory";

import type { HonoEnv } from "../env.js";
import { dispatchedFrom } from "../lib/dispatched-request.js";
import { logger } from "../lib/logger.js";

const loggerMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
    // The outer request of an in-process dispatch logs the call once, for both.
    if (dispatchedFrom(c.env)) {
        await next();

        return;
    }

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
