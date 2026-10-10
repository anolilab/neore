/**
 * Scoped console logger.
 *
 * ## Why not `@visulima/pail`
 *
 * It was `createPail({ stdout, stderr })` with hand-rolled stream wrappers whose
 * `write` implementations called `console.log` / `console.error` — the comment
 * on them said "for the hosted runtime". On Workers that indirection is not just
 * unnecessary, it is fatal:
 *
 *     Uncaught TypeError: The argument 'path' must be a file URL object,
 *     a file URL string, or an absolute path string.. Received 'undefined'
 *       at node:module:34:15 in createRequire
 *       at … `@visulima/interactive-manager` …
 *       at … `@visulima/pail`/dist/index.server.js
 *       at lunora/lib/logger.ts
 *
 * `@visulima/pail`'s `exports` map offers `import` -> `index.server.js` and
 * `browser` -> `index.browser.js`. A Worker build takes the `import` condition,
 * so it pulls the Node build, which reaches `createRequire` during module
 * evaluation. `nodejs_compat` is already on and does not help — the call gets
 * `undefined` for its path.
 *
 * This is module-INIT, so the worker never starts: every request 500s. It was
 * invisible to `lunora build`, which only bundles (esbuild resolves the import
 * happily), and only appeared on `lunora dev` — the same workerd that runs in
 * production.
 *
 * Nothing here needed a logging framework. Five methods are used across 50 call
 * sites — `debug` (105), `error` (50), `warn` (31), `info` (8), `scope` (2) —
 * and Cloudflare already captures `console.*` into the Workers log stream.
 */
export interface ScopedLogger {
    debug: (...arguments_: unknown[]) => void;
    error: (...arguments_: unknown[]) => void;
    info: (...arguments_: unknown[]) => void;
    scope: (name: string) => ScopedLogger;
    warn: (...arguments_: unknown[]) => void;
}

const create = (scopes: ReadonlyArray<string>): ScopedLogger => {
    const prefix = scopes.length > 0 ? `[${scopes.join(":")}]` : "";
    const at =
        (sink: (...arguments_: unknown[]) => void) =>
        (...arguments_: unknown[]) => {
            sink(prefix, ...arguments_);
        };

    return {
        // eslint-disable-next-line no-console
        debug: at(console.debug.bind(console)),
        // eslint-disable-next-line no-console
        error: at(console.error.bind(console)),
        // eslint-disable-next-line no-console
        info: at(console.info.bind(console)),
        scope: (name: string) => create([...scopes, name]),
        // eslint-disable-next-line no-console
        warn: at(console.warn.bind(console)),
    };
};

const baseLogger = create([]);

// Scoped loggers for different groups/modules
export const httpLogger = baseLogger.scope("http");
export const chatLogger = baseLogger.scope("chat");
export const authLogger = baseLogger.scope("auth");
export const cronsLogger = baseLogger.scope("crons");
export const emailLogger = baseLogger.scope("email");
export const gdprLogger = baseLogger.scope("gdpr");
export const promptsLogger = baseLogger.scope("prompts");
export const aiLogger = baseLogger.scope("ai");
export const scriptsLogger = baseLogger.scope("scripts");
export const toolsLogger = chatLogger.scope("tools");
export const storageLogger = baseLogger.scope("storage");
export const streamLogger = chatLogger.scope("stream");

// Export the base logger for custom scopes
export { baseLogger as logger };
