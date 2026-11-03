/**
 * Pure parts of the ports list: reading `ps`, `lsof` and `ss` output and walking the process tree. Nothing here
 * touches the system, so the rules are tested against a fake process table.
 */

/** Longest command name shown; the rest of a name is cut. Arguments are never read, so no secret in one can leak. */
export const MAX_NAME_CHARS = 40;

export interface ProcessInfo {
    /** The process name only (no path, no arguments). */
    name: string;
    pid: number;
    ppid: number;
    /** The start time as `ps` prints it. With the pid it identifies one process, so a reused pid does not match. */
    startedAt: string;
}

export interface Listener {
    address: string;
    pid: number;
    port: number;
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/u;

const baseName = (command: string): string => {
    const slash = command.lastIndexOf("/");

    return (slash === -1 ? command : command.slice(slash + 1)).slice(0, MAX_NAME_CHARS);
};

/** Parses `ps -axo pid=,ppid=,lstart=,comm=` (run with `LC_ALL=C`). Lines that do not fit are dropped. */
export const parsePs = (output: string): ProcessInfo[] => {
    const rows: ProcessInfo[] = [];

    for (const line of output.split("\n")) {
        const match = PS_LINE.exec(line);

        if (match !== null) {
            rows.push({ name: baseName(match[4] as string), pid: Number(match[1]), ppid: Number(match[2]), startedAt: (match[3] as string).replaceAll(/\s+/gu, " ") });
        }
    }

    return rows;
};

const splitAddress = (endpoint: string): { address: string; port: number } | undefined => {
    const colon = endpoint.lastIndexOf(":");
    const port = Number(endpoint.slice(colon + 1));

    if (colon === -1 || !Number.isInteger(port) || port < 1 || port > 65_535) {
        return undefined;
    }

    return { address: endpoint.slice(0, colon).replaceAll(/^\[|\]$/gu, ""), port };
};

/** Parses `lsof -F pn`: a `p<pid>` line, then one `n<address>:<port>` line per listening socket of that process. */
export const parseLsof = (output: string): Listener[] => {
    const listeners: Listener[] = [];
    let pid: number | undefined;

    for (const line of output.split("\n")) {
        if (line.startsWith("p")) {
            pid = Number(line.slice(1));
        } else if (line.startsWith("n") && pid !== undefined && Number.isInteger(pid)) {
            const endpoint = splitAddress(line.slice(1));

            if (endpoint !== undefined) {
                listeners.push({ ...endpoint, pid });
            }
        }
    }

    return listeners;
};

/** Parses `ss -ltnpH`: the fourth column is the local endpoint, and `pid=` names each owner. */
export const parseSs = (output: string): Listener[] => {
    const listeners: Listener[] = [];

    for (const line of output.split("\n")) {
        const columns = line.trim().split(/\s+/u);
        const endpoint = columns[3] === undefined ? undefined : splitAddress(columns[3]);

        if (endpoint === undefined) {
            continue;
        }

        for (const owner of line.matchAll(/pid=(\d+)/gu)) {
            listeners.push({ ...endpoint, pid: Number(owner[1]) });
        }
    }

    return listeners;
};

/** Every process below `rootPid`, never `rootPid` itself. A table with a cycle (a bad read) still ends. */
export const descendantsOf = (table: readonly ProcessInfo[], rootPid: number): ProcessInfo[] => {
    const children = new Map<number, ProcessInfo[]>();

    for (const row of table) {
        children.set(row.ppid, [...children.get(row.ppid) ?? [], row]);
    }

    const seen = new Set<number>([rootPid]);
    const found: ProcessInfo[] = [];
    const queue = [rootPid];

    for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
        for (const child of children.get(pid) ?? []) {
            if (!seen.has(child.pid)) {
                seen.add(child.pid);
                found.push(child);
                queue.push(child.pid);
            }
        }
    }

    return found;
};
