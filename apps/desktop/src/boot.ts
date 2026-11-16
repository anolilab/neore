// eslint-disable-next-line n/no-unsupported-features/node-builtins -- the main process runs on Electron 45's Node 24, which has both
import { enableCompileCache, flushCompileCache } from "node:module";
import path from "node:path";

import { app } from "electron";

/** Long enough after `ready` for the start-up code to have run (and been compiled), off the launch's critical path. */
const FLUSH_DELAY_MS = 10_000;

/**
 * The main-process entry (`package.json#main`). It turns on V8's compile cache, then loads the bundled main process,
 * so a launch after the first reads `main.cjs`'s compiled code from disk instead of compiling it again. Node keys each
 * entry by the file's content and its own version, so an update starts a new cache, and `NODE_DISABLE_COMPILE_CACHE=1`
 * turns it off. Not a `cache` folder in userData: macOS folds that name onto Chromium's `Cache`.
 */
enableCompileCache(path.join(app.getPath("userData"), "compile-cache"));

// Node writes the cache at a clean exit only. A tray app is often ended by a logout or a signal, so it is written once
// after start-up too.
app.once("ready", () => {
    setTimeout(flushCompileCache, FLUSH_DELAY_MS).unref();
});

// eslint-disable-next-line import/no-commonjs, @typescript-eslint/no-require-imports -- an import would load before the cache is on; esbuild leaves it external
require("./main.cjs");
