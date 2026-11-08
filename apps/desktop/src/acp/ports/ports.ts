/**
 * The ports an agent's processes listen on. Local window only: nothing here is reachable from the page, the backend
 * or an ACP command. The agent and every process below it are listed; anything outside the agent's tree never is.
 */
import type { Listener, ProcessInfo } from "./process-table";
import { descendantsOf } from "./process-table";

export interface PortView {
    address: string;
    name: string;
    pid: number;
    port: number;
}

export interface PortsSystem {
    /** The TCP sockets in LISTEN state owned by these pids. */
    listeners: (pids: number[]) => Promise<Listener[]>;
    processes: () => Promise<ProcessInfo[]>;
}

/** What tells two processes with one pid apart: `ps` start times are only to the second, so the name counts too. */
const identity = (row: ProcessInfo): string => JSON.stringify([row.startedAt, row.name]);

/** The agent's own row, if it is in the table, and every process below it. */
const agentTree = (table: ReadonlyArray<ProcessInfo>, agentPid: number): ProcessInfo[] => {
    const agent = table.find((row) => row.pid === agentPid);

    return agent === undefined ? [] : [agent, ...descendantsOf(table, agentPid)];
};

export class PortsService {
    public constructor(private readonly system: PortsSystem) {}

    public async list(agentPid: number | undefined): Promise<PortView[]> {
        if (agentPid === undefined) {
            return [];
        }

        const tree = agentTree(await this.system.processes(), agentPid);

        if (tree.length === 0) {
            return [];
        }

        const byPid = new Map(tree.map((row) => [row.pid, row]));
        const found = await this.system.listeners(tree.map((row) => row.pid));
        // A pid alone is not identity, and a process can leave the agent's tree meanwhile: re-read, and keep a socket only
        // while the process it was joined to is the same one (same start time) and still below the agent.
        const stillBelow = new Map(agentTree(await this.system.processes(), agentPid).map((row) => [row.pid, identity(row)]));
        const seen = new Set<string>();
        const views: PortView[] = [];

        for (const listener of found) {
            const row = byPid.get(listener.pid);
            const key = `${String(listener.pid)}:${listener.address}:${String(listener.port)}`;

            if (row !== undefined && !seen.has(key) && stillBelow.get(row.pid) === identity(row)) {
                seen.add(key);
                views.push({ address: listener.address, name: row.name, pid: row.pid, port: listener.port });
            }
        }

        // A total order, so the same sockets always come out the same way and an unchanged list is not redrawn.
        return views.toSorted((a, b) => a.port - b.port || a.pid - b.pid || a.address.localeCompare(b.address));
    }
}
