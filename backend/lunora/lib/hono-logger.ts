/**
 * Logger Middleware for Hono using `@visulima/pail`
 */
import type { MiddlewareHandler } from "hono";

import { httpLogger } from "./logger";

enum LogPrefix {
    Error = "xxx",
    Incoming = "<--",
    Outgoing = "-->",
}

/**
 * `1234` -> `1,234`.
 *
 * This was the textbook `/(\d)(?=(\d\d\d)+(?!\d))/g` grouping trick, whose nested
 * `+` inside a lookahead is re-evaluated per digit (40k digits took 0.8s).
 * `toLocaleString` produces the same string without the quantifier.
 */
const groupDigits = (value: number) => value.toLocaleString("en-US");

const time = (start: number) => {
    const delta = Date.now() - start;

    return delta < 1000 ? `${groupDigits(delta)}ms` : `${groupDigits(Math.round(delta / 1000))}s`;
};

const log = (prefix: string, method: string, path: string, status = 0, elapsed?: string) => {
    const out = prefix === LogPrefix.Incoming ? `${prefix} ${method} ${path}` : `${prefix} ${method} ${path} ${status} ${elapsed}`;

    // Use appropriate log level based on status code
    if (prefix === LogPrefix.Error || (status >= 500 && status < 600)) {
        httpLogger.error(out);
    } else if (status >= 400 && status < 500) {
        httpLogger.warn(out);
    } else {
        httpLogger.debug(out);
    }
};

/**
 * Logger Middleware for Hono using `@visulima/pail.`
 * @returns The middleware handler function.
 * @example
 * ```ts
 * import { Hono } from 'hono'
 * import { pailLogger } from './lib/hono-logger'
 *
 * const app = new Hono()
 *
 * app.use(pailLogger())
 * app.get('/', (c) => c.text('Hello Hono!'))
 * ```
 */
const pailLogger = (): MiddlewareHandler =>
    async function logger(c, next) {
        const { method, url } = c.req;

        const path = url.slice(url.indexOf("/", 8));

        log(LogPrefix.Incoming, method, path);

        const start = Date.now();

        await next();

        log(LogPrefix.Outgoing, method, path, c.res.status, time(start));
    };

export default pailLogger;
