/**
 * The messages between the main process and the terminal host, the child process that owns the
 * pseudo-terminal (`host.ts`). Plain JSON-able values: they cross a process boundary.
 */

export interface SpawnRequest {
    args: string[];
    cols: number;
    cwd: string;
    env: Record<string, string>;
    file: string;
    rows: number;
    type: "spawn";
}

export type HostRequest
    = | SpawnRequest
        | { data: string; type: "input" }
        | { cols: number; rows: number; type: "resize" }
        | { type: "kill" }
        | { type: "pause" }
        | { type: "resume" };

export type HostEvent
    = | { data: string; type: "data" }
        | { exitCode: number; signal: number; type: "exit" }
        | { message: string; type: "error" }
        | { pid: number; type: "started" };
