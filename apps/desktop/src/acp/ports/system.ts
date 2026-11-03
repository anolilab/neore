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
const LSOF = ["/usr/sbin/lsof", "/usr/bin/lsof"];
const SS = ["/usr/bin/ss", "/usr/sbin/ss", "/bin/ss"];
const TIMEOUT_MS = 5000;
const MAX_BUFFER = 16 * 1024 * 1024;

export const firstExisting = (paths: ReadonlyArray<string>, exists: (path: string) => boolean = existsSync): string | undefined =>
    paths.find((path) => exists(path));

/** Stdout of the tool; a non-zero exit with output is still output (`lsof` exits 1 when nothing matches). */
const run = async (file: string, args: string[]): Promise<string> =>
    await new Promise((resolve, reject) => {
        execFile(file, args, { encoding: "utf8", env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }, maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS }, (error, stdout) => {
            if (error !== null && stdout === "") {
                // Nothing listening is an empty answer, not a failure.
                if ((error as { code?: number | string }).code === 1) {
                    resolve("");
                } else {
                    reject(error);
                }

                return;
            }

            resolve(stdout);
        });
    });

export const portsSupported = process.platform === "darwin" || process.platform === "linux";

export const realPortsSystem: PortsSystem = {
    kill: (pid, signal) => {
        try {
            process.kill(pid, signal);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
                throw error;
            }
        }
    },
    listeners: async (pids): Promise<Listener[]> => {
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
        const ps = firstExisting(PS);

        if (ps === undefined) {
            throw new Error("ps is not installed, so processes cannot be listed");
        }

        return parsePs(await run(ps, ["-axo", "pid=,ppid=,lstart=,comm="]));
    },
    sleep: async (ms) => {
        await new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    },
};
