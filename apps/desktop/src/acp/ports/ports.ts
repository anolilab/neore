/**
 * The ports an agent's processes listen on, and stopping one of those servers. Local window only: nothing here is
 * reachable from the page, the backend or an ACP command.
 *
 * Stop signals by PID, never by process group. An agent runs in its own group and everything it starts inherits it, so
 * a group signal would end the agent along with the server. The listening process and its own descendants are
 * signalled one by one, each only after it is seen below this session's agent; the agent, this app and anything
 * outside the agent's tree are never targets.
 */
import type { Listener, ProcessInfo } from "./process-table";
import { descendantsOf } from "./process-table";

/** How long a polite stop waits before the survivors are killed. */
export const STOP_GRACE_MS = 2000;
const POLL_MS = 100;

export interface PortView {
    address: string;
    name: string;
    pid: number;
    port: number;
    /** With `pid`, names one process: a reused pid has another start time. */
    startedAt: string;
}

export interface PortsSystem {
    /** ESRCH (already gone) is not an error. */
    kill: (pid: number, signal: "SIGKILL" | "SIGTERM") => void;
    /** The TCP sockets in LISTEN state owned by these pids. */
    listeners: (pids: number[]) => Promise<Listener[]>;
    processes: () => Promise<ProcessInfo[]>;
    sleep: (ms: number) => Promise<void>;
}

export interface StopTarget {
    pid: number;
    startedAt: string;
}

/** The same process: a pid alone is not identity, since the system reuses pids. */
const sameProcess = (row: { pid: number; startedAt: string }, other: { pid: number; startedAt: string }): boolean =>
    row.pid === other.pid && row.startedAt === other.startedAt;

/** Which of `victims` are still running in `table`: the same process, and not a zombie (a zombie has already exited). */
const aliveOf = (table: ReadonlyArray<ProcessInfo>, victims: ReadonlyArray<ProcessInfo>): ProcessInfo[] =>
    table.filter((row) => row.zombie !== true && victims.some((victim) => sameProcess(victim, row)));

export class PortsService {
    public constructor(
        private readonly system: PortsSystem,
        /** This app's own pid: never a target, whatever the table says. */
        private readonly selfPid: number = process.pid,
        private readonly graceMs: number = STOP_GRACE_MS,
    ) {}

    public async list(agentPid: number | undefined): Promise<PortView[]> {
        if (agentPid === undefined) {
            return [];
        }

        const below = this.below(await this.system.processes(), agentPid);

        if (below.length === 0) {
            return [];
        }

        const byPid = new Map(below.map((row) => [row.pid, row]));
        const listeners = await this.system.listeners(below.map((row) => row.pid));
        const seen = new Set<string>();
        const views: PortView[] = [];

        for (const listener of listeners) {
            const row = byPid.get(listener.pid);
            const key = `${String(listener.pid)}:${listener.address}:${String(listener.port)}`;

            if (row !== undefined && !seen.has(key)) {
                seen.add(key);
                views.push({ address: listener.address, name: row.name, pid: row.pid, port: listener.port, startedAt: row.startedAt });
            }
        }

        return views.toSorted((a, b) => a.port - b.port || a.pid - b.pid);
    }

    /**
     * Ends the listening process `target` and its own descendants. Refused unless it is, right now, a descendant of
     * the agent that still listens. Resolves true once every one of them is gone.
     */
    public async stop(agentPid: number | undefined, target: StopTarget): Promise<boolean> {
        if (agentPid === undefined) {
            throw new Error("this session has no process on this computer");
        }

        const table = await this.system.processes();
        const root = this.below(table, agentPid).find((row) => sameProcess(row, target));

        if (root === undefined) {
            throw new Error("that server is no longer running in this session");
        }

        const rootListeners = await this.system.listeners([root.pid]);

        if (rootListeners.length === 0) {
            throw new Error("that process no longer listens on a port");
        }

        // Read the table again right before the first signal: a child the listener started since the list is part of its tree now.
        const fresh = await this.system.processes();
        const current = this.below(fresh, agentPid).find((row) => sameProcess(row, root));

        if (current === undefined) {
            throw new Error("that server is no longer running in this session");
        }

        const signalled: ProcessInfo[] = [current, ...this.newDescendants(fresh, [current], [current], agentPid)];
        let refused = false;

        for (const victim of signalled) {
            refused = !this.send(victim, "SIGTERM") || refused;
        }

        for (let waited = 0; waited < this.graceMs; waited += POLL_MS) {
            // eslint-disable-next-line no-await-in-loop -- each poll must wait for the previous check to finish
            const now = await this.system.processes();
            const alive = aliveOf(now, signalled);

            // A child a victim started while it was still running is ended the same way, before the victim goes.
            for (const newcomer of this.newDescendants(now, alive, signalled, agentPid)) {
                refused = !this.send(newcomer, "SIGTERM") || refused;
                signalled.push(newcomer);
            }

            if (alive.length === 0) {
                return true;
            }

            // eslint-disable-next-line no-await-in-loop -- waiting between polls is the point
            await this.system.sleep(POLL_MS);
        }

        // Each survivor is matched by pid AND start time in a fresh read, so a pid the system gave to another process is not signalled.
        const survivors = aliveOf(await this.system.processes(), signalled);

        for (const survivor of survivors) {
            refused = !this.send(survivor, "SIGKILL") || refused;
        }

        return !refused && aliveOf(await this.system.processes(), signalled).length === 0;
    }

    /** Descendants of the agent that may ever be signalled: never the agent, never this app. */
    private below(table: ReadonlyArray<ProcessInfo>, agentPid: number): ProcessInfo[] {
        return descendantsOf(table, agentPid).filter((row) => row.pid !== agentPid && row.pid !== this.selfPid);
    }

    /** Sends one signal. A process this app may not signal is reported, not thrown, so the other victims still get theirs. */
    private send(victim: ProcessInfo, signal: "SIGKILL" | "SIGTERM"): boolean {
        try {
            this.system.kill(victim.pid, signal);

            return true;
        } catch {
            return false;
        }
    }

    /** Descendants of `roots` not already `known`: never the agent, never this app, never a process listed twice. */
    private newDescendants(table: ReadonlyArray<ProcessInfo>, roots: ReadonlyArray<ProcessInfo>, known: ReadonlyArray<ProcessInfo>, agentPid: number): ProcessInfo[] {
        const found: ProcessInfo[] = [];

        for (const root of roots) {
            for (const row of descendantsOf(table, root.pid)) {
                const skipped = row.pid === agentPid || row.pid === this.selfPid;

                if (!skipped && known.every((entry) => !sameProcess(entry, row)) && found.every((entry) => !sameProcess(entry, row))) {
                    found.push(row);
                }
            }
        }

        return found;
    }
}
