/**
 * The ports an agent's processes listen on, and stopping one of those servers. Local window only: nothing here is
 * reachable from the page, the backend or an ACP command. The agent and every process below it are listed; anything
 * outside the agent's tree never is.
 *
 * Stop signals by PID, never by process group: an agent leads its own group and everything it starts inherits it, so a
 * group signal would end the agent with the server. The listening process and its own descendants are signalled one by
 * one, each only after a fresh process table shows it below this session's agent; never the agent, never this app.
 */
import type { Listener, ProcessInfo } from "./process-table";
import { descendantsOf } from "./process-table";

/** How long a polite stop waits before the survivors are killed. */
export const STOP_GRACE_MS = 2000;
const POLL_MS = 100;
const READ_ATTEMPTS = 3;

export interface PortView {
    address: string;
    /** The agent's own socket: listed, but never stopped here, since that would end the session. */
    agent: boolean;
    name: string;
    pid: number;
    port: number;
    /** With `pid` and `name`, tells one process from a later one that reused the pid. */
    startedAt: string;
}

/** The listed process a stop is for. */
export interface StopTarget {
    name: string;
    pid: number;
    startedAt: string;
}

/** How a stop ended; `reason` says in plain words why it did not. */
export type StopResult = { ended: true } | { ended: false; reason: string };

export const STOP_REASON = {
    gone: "that server is no longer listening in this session",
    left: "a process left the agent's processes before it ended, so it was not force-killed",
    refused: "a process could not be signalled (not permitted)",
    survived: "a process was still running after it was force-killed",
    unconfirmed: "it was force-killed, but the process list could not be read to confirm it ended",
    unlocated: "the process list or its listening sockets could not be read to find it, so nothing was signalled",
    unreadable: "the process list could not be read to confirm it, so nothing was force-killed",
} as const;

export interface PortsSystem {
    /** ESRCH (already gone) is not an error; any other refusal throws. */
    kill: (pid: number, signal: "SIGKILL" | "SIGTERM") => void;
    /** The TCP sockets in LISTEN state owned by these pids. */
    listeners: (pids: number[]) => Promise<Listener[]>;
    processes: () => Promise<ProcessInfo[]>;
    sleep: (ms: number) => Promise<void>;
}

/** What tells two processes with one pid apart: `ps` start times are only to the second, so the name counts too. */
const identity = (row: { name: string; startedAt: string }): string => JSON.stringify([row.startedAt, row.name]);

const sameProcess = (row: ProcessInfo, other: { name: string; pid: number; startedAt: string }): boolean =>
    row.pid === other.pid && identity(row) === identity(other);

/** Which of `victims` still run in `table`: the same process, and not a zombie (it has exited; its row stays until reaped). */
const aliveOf = (table: ReadonlyArray<ProcessInfo>, victims: ReadonlyArray<ProcessInfo>): ProcessInfo[] =>
    table.filter((row) => row.zombie !== true && victims.some((victim) => sameProcess(row, victim)));

/** The agent's own row, if it is in the table, and every process below it. */
const agentTree = (table: ReadonlyArray<ProcessInfo>, agentPid: number): ProcessInfo[] => {
    const agent = table.find((row) => row.pid === agentPid);

    return agent === undefined ? [] : [agent, ...descendantsOf(table, agentPid)];
};

export class PortsService {
    public constructor(
        private readonly system: PortsSystem,
        /** This app's own pid: never a target, whatever the table says. */
        private readonly selfPid: number = process.pid,
        private readonly graceMs: number = STOP_GRACE_MS,
        /** Milliseconds on a monotonic clock, injected so the grace deadline is tested without waiting. */
        private readonly now: () => number = () => performance.now(),
    ) {}

    public async list(agentPid: number | undefined): Promise<PortView[]> {
        if (agentPid === undefined) {
            return [];
        }

        const tree = agentTree(this.withoutSelf(await this.system.processes()), agentPid);

        if (tree.length === 0) {
            return [];
        }

        const byPid = new Map(tree.map((row) => [row.pid, row]));
        const found = await this.system.listeners(tree.map((row) => row.pid));
        // A pid alone is not identity, and a process can leave the agent's tree meanwhile: re-read, and keep a socket only
        // while the process it was joined to is the same one (same start time) and still below the agent.
        const reread = agentTree(this.withoutSelf(await this.system.processes()), agentPid);
        const stillBelow = new Map(reread.map((row) => [row.pid, identity(row)]));
        const seen = new Set<string>();
        const views: PortView[] = [];

        for (const listener of found) {
            const row = byPid.get(listener.pid);
            const key = `${String(listener.pid)}:${listener.address}:${String(listener.port)}`;

            if (row !== undefined && !seen.has(key) && stillBelow.get(row.pid) === identity(row)) {
                seen.add(key);
                views.push({ address: listener.address, agent: row.pid === agentPid, name: row.name, pid: row.pid, port: listener.port, startedAt: row.startedAt });
            }
        }

        // A total order, so the same sockets always come out the same way and an unchanged list is not redrawn.
        return views.toSorted((a, b) => a.port - b.port || a.pid - b.pid || a.address.localeCompare(b.address));
    }

    /**
     * Ends the listening process `target` and its own descendants: SIGTERM, then SIGKILL for the survivors after the
     * grace period. Refused unless `target` is, in a fresh read, below the agent and still listening.
     */
    public async stop(agentPid: number | undefined, target: StopTarget): Promise<StopResult> {
        let root: Awaited<ReturnType<PortsService["locate"]>>;

        try {
            root = await this.locate(agentPid, target);
        } catch {
            return { ended: false, reason: STOP_REASON.unlocated };
        }

        if (root === undefined || agentPid === undefined) {
            return { ended: false, reason: STOP_REASON.gone };
        }

        const signalled: ProcessInfo[] = [root.current, ...this.newcomers(root.table, [root.current], [root.current], agentPid)];
        // Children before parents (the list is breadth-first): a child is signalled while its parent still holds it in the tree.
        const refused = signalled.toReversed().map((victim) => !this.send(victim, "SIGTERM")).includes(true);

        return await this.awaitGone(signalled, refused, agentPid);
    }

    /** Polls until every victim is gone or the grace period ends, then escalates. Both the polls and the clock count: a slow table read spends grace time too. */
    private async awaitGone(signalled: ProcessInfo[], alreadyRefused: boolean, agentPid: number): Promise<StopResult> {
        let refused = alreadyRefused;
        const deadline = this.now() + this.graceMs;

        for (let waited = 0; waited < this.graceMs && this.now() < deadline; waited += POLL_MS) {
            // eslint-disable-next-line no-await-in-loop -- each poll waits for the previous one
            const table = await this.tryProcesses();

            if (table !== undefined) {
                const alive = aliveOf(table, signalled);
                // A child a victim started meanwhile goes down the same way, before its parent is gone; only below a
                // victim still below the agent, so a victim the system re-parented takes no new signals to its tree.
                const roots = aliveOf(this.below(table, agentPid), signalled);

                for (const newcomer of this.newcomers(table, roots, signalled, agentPid).toReversed()) {
                    refused = !this.send(newcomer, "SIGTERM") || refused;
                    signalled.push(newcomer);
                }

                if (alive.length === 0) {
                    return refused ? { ended: false, reason: STOP_REASON.refused } : { ended: true };
                }
            }

            // eslint-disable-next-line no-await-in-loop -- waiting between polls is the point
            await this.system.sleep(POLL_MS);
        }

        return await this.escalate(signalled, refused, agentPid);
    }

    /** The target as it is right now: below the agent, still listening, and found again in a second read taken just before the first signal. */
    private async locate(agentPid: number | undefined, target: StopTarget): Promise<{ current: ProcessInfo; table: ProcessInfo[] } | undefined> {
        if (agentPid === undefined) {
            return undefined;
        }

        const first = this.below(await this.system.processes(), agentPid).find((row) => sameProcess(row, target));

        if (first === undefined) {
            return undefined;
        }

        const sockets = await this.system.listeners([first.pid]);

        if (sockets.length === 0) {
            return undefined;
        }

        // A child the listener started since the list is part of its tree now.
        const table = await this.system.processes();
        const current = this.below(table, agentPid).find((row) => sameProcess(row, first));

        return current === undefined ? undefined : { current, table };
    }

    /** SIGKILL for what still runs, matched by pid and identity in a fresh read; without that read nothing is killed. */
    private async escalate(signalled: ProcessInfo[], alreadyRefused: boolean, agentPid: number): Promise<StopResult> {
        const last = await this.readProcesses();

        if (last === undefined) {
            return { ended: false, reason: STOP_REASON.unreadable };
        }

        let refused = alreadyRefused;
        // Only what is still below the agent: a survivor the system re-parented (to pid 1, say) has left its tree.
        const stillBelow = this.below(last, agentPid);
        const survivors = aliveOf(stillBelow, signalled);
        const newcomers = this.newcomers(last, survivors, signalled, agentPid);

        const targets = [...survivors, ...newcomers];

        // Deepest first, by the breadth-first order of the agent's tree: a SIGKILL ends a parent at once, and a child it
        // leaves behind would be re-parented out of the tree before its own signal.
        const deepestFirst = stillBelow.filter((row) => targets.some((target) => sameProcess(row, target))).toReversed();

        for (const target of deepestFirst) {
            refused = !this.send(target, "SIGKILL") || refused;
        }

        signalled.push(...newcomers);

        // A process can take a moment to go after SIGKILL (a large heap, an uninterruptible wait): give it one poll.
        await this.system.sleep(POLL_MS);

        const after = await this.readProcesses();

        if (after === undefined) {
            return { ended: false, reason: STOP_REASON.unconfirmed };
        }

        if (refused) {
            return { ended: false, reason: STOP_REASON.refused };
        }

        if (aliveOf(this.below(after, agentPid), signalled).length > 0) {
            return { ended: false, reason: STOP_REASON.survived };
        }

        return aliveOf(after, signalled).length > 0 ? { ended: false, reason: STOP_REASON.left } : { ended: true };
    }

    /** One table read, or undefined when it failed (a slow or failing `ps`). */
    private async tryProcesses(): Promise<ProcessInfo[] | undefined> {
        try {
            return await this.system.processes();
        } catch {
            return undefined;
        }
    }

    private async readProcesses(): Promise<ProcessInfo[] | undefined> {
        for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop -- attempts are sequential by design
            const table = await this.tryProcesses();

            if (table !== undefined) {
                return table;
            }
        }

        return undefined;
    }

    /** What may ever be signalled: below the agent, never the agent, never this app, and nothing reached only through it. */
    private below(table: ReadonlyArray<ProcessInfo>, agentPid: number): ProcessInfo[] {
        return descendantsOf(this.withoutSelf(table), agentPid);
    }

    /** The table without this app's row, so no walk goes on through it; a bad read could place it anywhere. */
    private withoutSelf(table: ReadonlyArray<ProcessInfo>): ProcessInfo[] {
        return table.filter((row) => row.pid !== this.selfPid);
    }

    /** A refused signal is reported, not thrown, so the other victims still get theirs. */
    private send(victim: ProcessInfo, signal: "SIGKILL" | "SIGTERM"): boolean {
        try {
            this.system.kill(victim.pid, signal);

            return true;
        } catch {
            return false;
        }
    }

    /** Running descendants of `roots` that are not `known` yet. Never the agent (a cyclic read could reach it), this app, or a zombie (it has exited). */
    private newcomers(
        table: ReadonlyArray<ProcessInfo>,
        roots: ReadonlyArray<ProcessInfo>,
        known: ReadonlyArray<ProcessInfo>,
        agentPid: number,
    ): ProcessInfo[] {
        const found: ProcessInfo[] = [];
        // Neither the agent nor this app is walked through: a bad read that puts one below a victim must not widen the stop.
        const walked = this.withoutSelf(table).filter((row) => row.pid !== agentPid);

        for (const root of roots) {
            for (const row of descendantsOf(walked, root.pid)) {
                if (row.zombie !== true && row.pid !== agentPid && row.pid !== this.selfPid && [...known, ...found].every((entry) => !sameProcess(entry, row))) {
                    found.push(row);
                }
            }
        }

        return found;
    }
}
