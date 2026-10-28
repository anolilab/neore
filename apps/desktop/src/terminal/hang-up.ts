import { execFile } from "node:child_process";
import path from "node:path";

import { windowsSystem32 } from "./shell";

/**
 * Ends a shell the way a terminal closing would. POSIX shells get `SIGHUP`. Windows has no hangup and `process.kill` can only
 * terminate the one process, so the whole tree is ended by `taskkill`, which is also what the pseudoconsole closing would do to
 * its clients; `node-pty`'s own `kill` is not used there because it forks a helper script that a packaged app cannot run.
 * `taskkill` is started and not waited for, so several shells are ended in parallel under the same deadline and the main process
 * is never blocked on them; a caller that must see the shell gone polls for it. A shell that is already gone is not an error.
 */
export const hangUp = (pid: number, platform: NodeJS.Platform = process.platform, run: typeof execFile = execFile): void => {
    try {
        if (platform === "win32") {
            const taskkill = path.win32.join(windowsSystem32(), "taskkill.exe");

            run(taskkill, ["/pid", String(pid), "/t", "/f"], { timeout: 3000, windowsHide: true }, () => {});
        } else {
            process.kill(pid, "SIGHUP");
        }
    } catch {
        // Already gone.
    }
};
