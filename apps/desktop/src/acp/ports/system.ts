/**
 * The real process table and listening sockets. Tools are run by absolute path, never found through PATH, and the
 * environment is minimal; only pids are passed as arguments.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

import type { PortsSystem } from "./ports";
import type { Listener } from "./process-table";
import { parseLsof, parsePs, parseSs } from "./process-table";

const PS = ["/bin/ps", "/usr/bin/ps"];
const LSOF = ["/usr/sbin/lsof", "/usr/bin/lsof", "/sbin/lsof", "/bin/lsof"];
const SS = ["/usr/bin/ss", "/usr/sbin/ss", "/bin/ss", "/sbin/ss"];
const TIMEOUT_MS = 5000;
const MAX_BUFFER = 16 * 1024 * 1024;

export const firstExisting = (paths: ReadonlyArray<string>, exists: (path: string) => boolean = existsSync): string | undefined =>
    paths.find((path) => exists(path));

/** True when stderr is empty or holds only lsof's own `lsof: WARNING:` notices (it prints one for a filesystem it cannot stat, with no listener missing). */
const onlyNotices = (stderr: string): boolean =>
    stderr
        .split("\n")
        .map((line) => line.trim())
        .every((line) => line === "" || line.startsWith("lsof: WARNING:") || line === "Output information may be incomplete.");

/**
 * Stdout of the tool. A failed run is refused even when some output arrived (a timeout, an overflow or a crash can leave a
 * partial table, and acting on it would hide processes). The one exception is `lsof` exiting 1 on its own: a pid it was
 * asked about is gone, and what it printed for the others is complete.
 */
const run = async (file: string, args: string[]): Promise<string> =>
    await new Promise((resolve, reject) => {
        execFile(file, args, { encoding: "utf8", env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }, maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS }, (error, stdout, stderr) => {
            if (error === null) {
                resolve(stdout);

                return;
            }

            // lsof exits 1 when a requested pid is gone (a short-lived child) and still prints the sockets of the others.
            const failure = error as { code?: number | string; killed?: boolean; signal?: string | null };

            if (LSOF.includes(file) && failure.code === 1 && onlyNotices(String(stderr)) && failure.killed !== true && (failure.signal ?? null) === null) {
                resolve(stdout);

                return;
            }

            reject(error);
        });
    });

export const portsSupported = process.platform === "darwin" || process.platform === "linux";

/** Listing needs `ps` and `lsof` or `ss`: said once, where the list is shown, instead of a missing-tool error. */
const requireSupported = (): void => {
    if (process.platform !== "darwin" && process.platform !== "linux") {
        throw new Error("The ports list is not available on this computer: it needs ps and lsof or ss, which exist on macOS and Linux only.");
    }
};

export const realPortsSystem: PortsSystem = {
    listeners: async (pids): Promise<Listener[]> => {
        requireSupported();

        if (pids.length === 0) {
            return [];
        }

        const wanted = new Set(pids);
        const lsof = firstExisting(LSOF);

        if (lsof !== undefined) {
            return parseLsof(await run(lsof, ["-nP", "-a", "-p", pids.join(","), "-iTCP", "-sTCP:LISTEN", "-F", "pn"])).filter((listener) =>
                wanted.has(listener.pid),
            );
        }

        const ss = firstExisting(SS);

        if (ss === undefined) {
            throw new Error("neither lsof nor ss is installed, so listening ports cannot be read");
        }

        return parseSs(await run(ss, ["-ltnpH"])).filter((listener) => wanted.has(listener.pid));
    },
    processes: async () => {
        requireSupported();

        const ps = firstExisting(PS);

        if (ps === undefined) {
            throw new Error("ps is not installed, so processes cannot be listed");
        }

        // macOS `comm` is argv[0], which a process sets itself (and title-setting tools fill with arguments); `ucomm` is the
        // kernel's own name there. Linux `comm` already is the kernel name.
        return parsePs(await run(ps, ["-axo", `pid=,ppid=,stat=,lstart=,${process.platform === "darwin" ? "ucomm" : "comm"}=`]));
    },
};
