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

/** The same process: a pid alone is not identity, since the system reuses pids. */
const sameProcess = (row: ProcessInfo, other: ProcessInfo): boolean => row.pid === other.pid && row.startedAt === other.startedAt;

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
        // A pid alone is not identity: re-read, and keep a socket only while the process it was joined to is still the same one.
        const reread = await this.system.processes();
        const seen = new Set<string>();
        const views: PortView[] = [];

        for (const listener of found) {
            const row = byPid.get(listener.pid);
            const key = `${String(listener.pid)}:${listener.address}:${String(listener.port)}`;

            if (row !== undefined && !seen.has(key) && reread.some((entry) => sameProcess(entry, row))) {
                seen.add(key);
                views.push({ address: listener.address, name: row.name, pid: row.pid, port: listener.port });
            }
        }

        return views.toSorted((a, b) => a.port - b.port || a.pid - b.pid);
    }
}
