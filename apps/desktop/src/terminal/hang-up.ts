import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Ends a shell the way a terminal closing would. POSIX shells get `SIGHUP`. Windows has no hangup and `process.kill` can only
 * terminate the one process, so the whole tree is ended by `taskkill`, which is also what the pseudoconsole closing would do to
 * its clients; `node-pty`'s own `kill` is not used there because it forks a helper script that a packaged app cannot run.
 * Blocks (briefly) on Windows, so the shell is gone when this returns. A shell that is already gone is not an error.
 */
export const hangUp = (pid: number, platform: NodeJS.Platform = process.platform, run: typeof execFileSync = execFileSync): void => {
    try {
        if (platform === "win32") {
            const taskkill = path.win32.join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32", "taskkill.exe");

            run(taskkill, ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", timeout: 3000, windowsHide: true });
        } else {
            process.kill(pid, "SIGHUP");
        }
    } catch {
        // Already gone.
    }
};
