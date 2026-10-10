/**
 * Worker-safe logger.
 *
 * `@visulima/pail` cannot load in workerd: its entry calls Node's
 * `createRequire`, and the Worker died at startup with
 * `TypeError: The argument 'path' must be a file URL object … Received 'undefined'
 *  at node:module in createRequire`
 * — so the whole gateway failed to boot, and the app's model list 502'd.
 *
 * Only `info`/`warn`/`error` were ever used, so this is a console shim rather
 * than a dependency. Workers' console output is captured by wrangler and by
 * Cloudflare's logging in production.
 */
export interface Logger {
    error: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
}

const TAG = "[llm-gateway]";

export const logger: Logger = {
    error: (...args: unknown[]) => console.error(TAG, ...args),
    info: (...args: unknown[]) => console.log(TAG, ...args),
    warn: (...args: unknown[]) => console.warn(TAG, ...args),
};
