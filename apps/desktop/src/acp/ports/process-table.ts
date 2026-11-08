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

/** `ps` start time after its spaces are squeezed to one: `Tue Nov 3 20:10:49 2026`. */
const LSTART = /^\w{3} \w{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u;
const SPACES = /\s+/u;
const DIGITS = /^\d+$/u;
/** One owner entry of `users:((...),(...))`: the quoted process name, then its pid. The name is matched whole, so a `pid=` inside it is never read. */
const OWNER_ENTRY = /\("(?:[^"\\]|\\.)*",pid=(\d+),fd=\d+\)(?:,|\)|$)/uy;
const USERS = "users:(";

/** The pids in the `users:` column of an `ss` row, read entry by entry from where the column starts. */
const ssOwnerPids = (line: string): number[] => {
    const start = line.indexOf(USERS);
    const pids: number[] = [];

    if (start === -1) {
        return pids;
    }

    let at = start + USERS.length;

    for (;;) {
        OWNER_ENTRY.lastIndex = at;
        const entry = OWNER_ENTRY.exec(line);

        if (entry === null) {
            break;
        }

        pids.push(Number(entry[1]));
        at = OWNER_ENTRY.lastIndex;
    }

    // `ss` does not escape a quote inside a name, so a name with one can pose as another entry. Each real entry has exactly
    // two quotes; any other count means the column cannot be read safely, and the row is dropped rather than misattributed.
    const quotes = line.slice(start).split('"').length - 1;

    return quotes === pids.length * 2 ? pids : [];
};

const baseName = (command: string): string => {
    const slash = command.lastIndexOf("/");

    return (slash === -1 ? command : command.slice(slash + 1)).slice(0, MAX_NAME_CHARS);
};

/** One `ps` line: pid, ppid, state, the start time (five words), then the command. Anything else is not a process. */
const parsePsLine = (line: string): ProcessInfo | undefined => {
    const [pidText, ppidText, state, ...rest] = line.trim().split(SPACES);

    if (pidText === undefined || ppidText === undefined || state === undefined || !DIGITS.test(pidText) || !DIGITS.test(ppidText)) {
        return undefined;
    }

    const startedAt = rest.slice(0, 5).join(" ");
    const command = rest.slice(5).join(" ");

    if (command === "" || !LSTART.test(startedAt)) {
        return undefined;
    }

    return { name: baseName(command), pid: Number(pidText), ppid: Number(ppidText), startedAt };
};

/** Parses `ps -axo pid=,ppid=,stat=,lstart=,comm=` (`ucomm=` on macOS; run with `LC_ALL=C`). Lines that do not fit are dropped. */
export const parsePs = (output: string): ProcessInfo[] => {
    const rows: ProcessInfo[] = [];

    for (const line of output.split("\n")) {
        const row = parsePsLine(line);

        if (row !== undefined) {
            rows.push(row);
        }
    }

    return rows;
};

const splitAddress = (endpoint: string): { address: string; port: number } | undefined => {
    const colon = endpoint.lastIndexOf(":");
    const port = Number(endpoint.slice(colon + 1));

    if (colon === -1 || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        return undefined;
    }

    return { address: endpoint.slice(0, colon).replaceAll(/^\[|\]$/gu, ""), port };
};

/** Parses `lsof -F pn`: a line starting with `p` and the pid, then one line starting with `n` and the address and port per listening socket of that process. */
export const parseLsof = (output: string): Listener[] => {
    const listeners: Listener[] = [];
    let pid: number | undefined;

    for (const line of output.split("\n")) {
        if (line.startsWith("p")) {
            pid = Number(line.slice(1));
        } else if (pid !== undefined && line.startsWith("n")) {
            const endpoint = splitAddress(line.slice(1));

            if (endpoint !== undefined && Number.isSafeInteger(pid)) {
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
        const columns = line.trim().split(SPACES);
        const endpoint = columns[3] === undefined ? undefined : splitAddress(columns[3]);

        if (endpoint === undefined) {
            continue;
        }

        for (const pid of ssOwnerPids(line)) {
            listeners.push({ ...endpoint, pid });
        }
    }

    return listeners;
};

/** Every process below `rootPid`, never `rootPid` itself. A table with a cycle (a bad read) still ends. */
export const descendantsOf = (table: ReadonlyArray<ProcessInfo>, rootPid: number): ProcessInfo[] => {
    const children = new Map<number, ProcessInfo[]>();

    for (const row of table) {
        const siblings = children.get(row.ppid) ?? [];

        siblings.push(row);
        children.set(row.ppid, siblings);
    }

    const seen = new Set<number>([rootPid]);
    const found: ProcessInfo[] = [];
    const queue = [rootPid];

    // An index into the queue, not `shift()`, so the walk stays linear in the number of processes.
    for (let next = 0; next < queue.length; next += 1) {
        const kids = children.get(queue[next] as number) ?? [];
        const fresh = kids.filter((row) => !seen.has(row.pid));

        for (const child of fresh) {
            seen.add(child.pid);
            found.push(child);
            queue.push(child.pid);
        }
    }

    return found;
};
