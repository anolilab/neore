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
        const views = new Map<string, PortView>();

        for (const listener of await this.system.listeners([...byPid.keys()])) {
            const row = byPid.get(listener.pid);

            if (row !== undefined) {
                views.set(`${String(listener.pid)}:${listener.address}:${String(listener.port)}`, { address: listener.address, name: row.name, pid: row.pid, port: listener.port, startedAt: row.startedAt });
            }
        }

        return [...views.values()].sort((a, b) => a.port - b.port || a.pid - b.pid);
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
        const root = this.below(table, agentPid).find((row) => row.pid === target.pid && row.startedAt === target.startedAt);

        if (root === undefined) {
            throw new Error("that server is no longer running in this session");
        }

        if ((await this.system.listeners([root.pid])).length === 0) {
            throw new Error("that process no longer listens on a port");
        }

        // The listener's own subtree only; a malformed table cannot put the agent or this app in it.
        const victims = [root, ...descendantsOf(table, root.pid).filter((row) => row.pid !== agentPid && row.pid !== this.selfPid)];

        for (const victim of victims) {
            this.system.kill(victim.pid, "SIGTERM");
        }

        for (let waited = 0; waited < this.graceMs; waited += POLL_MS) {
            if ((await this.existing(victims)).length === 0) {
                return true;
            }

            await this.system.sleep(POLL_MS);
        }

        // Pid AND start time: a pid the system gave to another process since the check above is not ours to kill.
        for (const survivor of await this.existing(victims)) {
            this.system.kill(survivor.pid, "SIGKILL");
        }

        return (await this.existing(victims)).length === 0;
    }

    /** Descendants of the agent that may ever be signalled: never the agent, never this app. */
    private below(table: readonly ProcessInfo[], agentPid: number): ProcessInfo[] {
        return descendantsOf(table, agentPid).filter((row) => row.pid !== agentPid && row.pid !== this.selfPid);
    }

    /**
     * Which of `victims` still exist as the same process. Not required to sit below the agent any more: a victim
     * whose parent died was reparented, and it is still the process we were told to end.
     */
    private async existing(victims: readonly ProcessInfo[]): Promise<ProcessInfo[]> {
        const now = new Map((await this.system.processes()).map((row) => [row.pid, row]));

        return victims.filter((victim) => now.get(victim.pid)?.startedAt === victim.startedAt);
    }
}
