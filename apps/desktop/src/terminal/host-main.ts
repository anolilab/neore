/**
 * Entry of the terminal host bundle (`dist/terminal-host.cjs`). Started by the main process as an Electron
 * utility process, which talks over `parentPort`; the tests start the same bundle with `child_process.fork`.
 */
import path from "node:path";

import { runHost } from "./host";
import type { HostEvent, HostRequest } from "./protocol";
import { loadableDirectory, makeSpawnHelperExecutable } from "./spawn-helper";

const port = process.parentPort;
const ptyDirectory = (): string => path.dirname(require.resolve("node-pty/package.json"));

runHost(
    port === undefined
        ? {
            onClose: (listener) => process.on("disconnect", listener),
            onMessage: (listener) => process.on("message", (message) => listener(message as HostRequest)),
            post: (event: HostEvent) => {
                process.send?.(event);
            },
        }
        : {
            // A utility process's port has no close event; the parent-process check in `runHost` covers the app dying.
            onClose: () => {},
            onMessage: (listener) => port.on("message", (event) => listener(event.data as HostRequest)),
            post: (event: HostEvent) => port.postMessage(event),
        },
    // node-pty is a native module, so it stays external to the bundle and is loaded here, on the first spawn.
    // eslint-disable-next-line global-require, import/no-dynamic-require, @typescript-eslint/no-require-imports -- loaded on demand so a failing load is reported, not fatal
    () => require(loadableDirectory(ptyDirectory())),
    () => makeSpawnHelperExecutable(ptyDirectory()),
);
