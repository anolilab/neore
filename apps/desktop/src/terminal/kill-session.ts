import { spawnSync } from "node:child_process";

const WHITESPACE = /\s+/u;

/**
 * The processes below `pid` (children, their children, ...), found through `ps` so it works the same on Linux and
 * macOS. A foreground job is a child of the shell, and one that ignores the hangup outlives it unless it is
 * signalled itself, so the caller takes this before the shell goes. Empty on Windows or when `ps` is missing.
 */
export const descendantsOf = (pid: number): number[] => {
    if (process.platform === "win32") {
        return [];
    }

    try {
        // eslint-disable-next-line sonarjs/no-os-command-from-path -- `ps` is the portable way to read the process tree, and the arguments are fixed
        const listing = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000 });
        const childrenOf = new Map<number, number[]>();

        const lines = String(listing.stdout ?? "").split("\n");

        for (const line of lines) {
            const [child, parent] = line.trim().split(WHITESPACE).map(Number);

            if (child !== undefined && parent !== undefined && Number.isSafeInteger(child) && Number.isSafeInteger(parent)) {
                childrenOf.set(parent, [...childrenOf.get(parent) ?? [], child]);
            }
        }

        const found: number[] = [];
        const queue = [pid];

        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
            const children = childrenOf.get(next) ?? [];

            for (const child of children) {
                found.push(child);
                queue.push(child);
            }
        }

        return found;
    } catch {
        return [];
    }
};

/** SIGKILL for each pid that is still there. */
export const killAll = (pids: Iterable<number>): void => {
    for (const pid of pids) {
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            // Already gone.
        }
    }
};
