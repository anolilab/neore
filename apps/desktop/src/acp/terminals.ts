/**
 * A coding agent's terminals (ACP `terminal/*`), served by the main process and run by the Rust core in the `shell_run`
 * sandbox (`device-core/src/acp_terminal.rs`): the shared folders are the only writable place, the network tier is
 * `shell_run`'s, and where there is no sandbox nothing runs. Each `terminal/create` is a once-only permission request
 * the person answers in this computer's window (never "always", never in a batch, never allowed from another device).
 *
 * A session owns its terminals: an id names one only in the session that made it, at most
 * {@link MAX_SESSION_TERMINALS} are open at once, and every one is killed when the turn is cancelled and released when
 * the session ends. Only sessions whose folder is on this computer advertise the capability: a server's agent would
 * otherwise run its commands here.
 */
import { randomUUID } from "node:crypto";

import { isRecord } from "./child-updates";
import { INVALID_PARAMS, RpcError } from "./rpc-error";

/** Terminals one session may have open (made and not released) at once. */
export const MAX_SESSION_TERMINALS = 4;

/**
 * The longest line the person is shown, in UTF-8 bytes: the core cuts a request's command at this
 * (`acp_permission.rs`, `MAX_TEXT * 4`), and a command allowed must be one the person read whole.
 */
const MAX_SHOWN_BYTES = 4000;
/** Ended terminals whose results a session keeps after their release, for the tool rows that show them. */
const KEPT_RESULTS = 16;
const MAX_ENV = 64;
const ENV_NAME = /^[A-Z_a-z]\w{0,127}$/u;
/** A word the shell reads back unchanged without quotes. */
const PLAIN_WORD = /^[\w%+,./:=@-]+$/u;

/** How a terminal's command ended, as the core and ACP say it. */
export interface TerminalExitStatus {
    exitCode: number | null;
    signal: string | null;
}

export interface TerminalOutput {
    exitStatus: TerminalExitStatus | null;
    output: string;
    truncated: boolean;
}

/** What a session asks the core to start, once the person allowed it. */
export interface TerminalStart {
    agentKey: string;
    cwd?: string;
    env: [string, string][];
    folder: string;
    line: string;
    outputByteLimit?: number;
}

/** The core's terminals, as a session uses them (`coreTerminals`). */
export interface TerminalHost {
    kill: (handle: number) => void;
    output: (handle: number) => TerminalOutput;
    release: (handle: number) => void;
    start: (request: TerminalStart) => Promise<number>;
    wait: (handle: number) => Promise<TerminalExitStatus>;
}

/** The core's `acpTerminal*` methods. */
export interface TerminalCore {
    acpTerminalKill: (handle: number) => void;
    acpTerminalOutput: (handle: number) => string;
    acpTerminalRelease: (handle: number) => void;
    acpTerminalStart: (request: string) => Promise<number>;
    acpTerminalWait: (handle: number) => Promise<string>;
}

const exitOf = (value: unknown): TerminalExitStatus => {
    const fields = isRecord(value) ? value : {};

    return {
        exitCode: typeof fields.exitCode === "number" ? fields.exitCode : null,
        signal: typeof fields.signal === "string" ? fields.signal : null,
    };
};

export const coreTerminals = (core: TerminalCore): TerminalHost => {
    return {
        kill: (handle) => core.acpTerminalKill(handle),
        output: (handle) => {
            const parsed: unknown = JSON.parse(core.acpTerminalOutput(handle));
            const fields = isRecord(parsed) ? parsed : {};

            return {
                exitStatus: isRecord(fields.exitStatus) ? exitOf(fields.exitStatus) : null,
                output: typeof fields.output === "string" ? fields.output : "",
                truncated: fields.truncated === true,
            };
        },
        release: (handle) => core.acpTerminalRelease(handle),
        start: async (request) => await core.acpTerminalStart(JSON.stringify(request)),
        wait: async (handle) => exitOf(JSON.parse(await core.acpTerminalWait(handle))),
    };
};

/** A word as the shell reads it back unchanged: bare when it is plainly safe, else in single quotes. */
export const shellQuote = (word: string): string => PLAIN_WORD.test(word) ? word : `'${word.replaceAll("'", String.raw`'\''`)}'`;

/**
 * The line the shell runs: the agent's `command` as it sent it (agents often send a whole shell line there) and each
 * argument quoted after it. Exactly this is what the person is asked about.
 */
export const terminalLine = (command: string, args: ReadonlyArray<string>): string => [command, ...args.map((argument) => shellQuote(argument))].join(" ");

/** The line as the person is shown it: the variables the agent sets first, as the shell would read them. */
export const shownLine = (line: string, env: ReadonlyArray<[string, string]>): string =>
    [...env.map(([name, value]) => `${name}=${shellQuote(value)}`), line].join(" ");

/** The variables a `terminal/create` sets, checked. Throws `INVALID_PARAMS` for one the shell could not take as named. */
const envOf = (env: unknown): [string, string][] => {
    if (env === undefined || env === null) {
        return [];
    }

    if (!Array.isArray(env) || env.length > MAX_ENV) {
        throw new RpcError(INVALID_PARAMS, "invalid environment");
    }

    return (env as unknown[]).map((entry) => {
        if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.value !== "string" || !ENV_NAME.test(entry.name) || entry.value.includes("\0")) {
            throw new RpcError(INVALID_PARAMS, "invalid environment variable");
        }

        return [entry.name, entry.value];
    });
};

/** A `terminal/create` request, checked: what to run, where, and with which variables. Throws `INVALID_PARAMS` otherwise. */
export const createRequestOf = (params: Record<string, unknown>): { cwd?: string; env: [string, string][]; line: string; outputByteLimit?: number; shown: string } => {
    const { args, command, cwd, env, outputByteLimit } = params;

    if (typeof command !== "string" || command.trim() === "") {
        throw new RpcError(INVALID_PARAMS, "a terminal needs a command");
    }

    if (args !== undefined && args !== null && (!Array.isArray(args) || args.some((argument) => typeof argument !== "string"))) {
        throw new RpcError(INVALID_PARAMS, "arguments are strings");
    }

    if (cwd !== undefined && cwd !== null && (typeof cwd !== "string" || !cwd.startsWith("/"))) {
        throw new RpcError(INVALID_PARAMS, "the working folder is an absolute path");
    }

    const variables = envOf(env);

    const line = terminalLine(command.trim(), (args as string[] | null | undefined) ?? []);

    const shown = shownLine(line, variables);

    if (Buffer.byteLength(shown) > MAX_SHOWN_BYTES || line.includes("\0")) {
        throw new RpcError(INVALID_PARAMS, "the command is too long");
    }

    return {
        env: variables,
        line,
        shown,
        ...typeof cwd === "string" && { cwd },
        ...typeof outputByteLimit === "number" && Number.isSafeInteger(outputByteLimit) && outputByteLimit > 0 && { outputByteLimit },
    };
};

interface OpenTerminal {
    /** Set once the command ended: what it printed (raw) and how it ended, for the tool row that shows it. */
    ended?: { exit: TerminalExitStatus; output: string };
    handle: number;
    released: boolean;
}

/** One session's terminals. Ids are minted here, never the core's handles, so an agent can name only its own. */
export class SessionTerminals {
    private readonly open = new Map<string, OpenTerminal>();

    public constructor(
        private readonly host: TerminalHost,
        /** Told when a terminal's command ended, so the tool calls that show it are reported again. */
        private readonly ended: (terminalId: string) => void,
    ) {}

    /** Terminals made and not yet released. */
    public get live(): number {
        let count = 0;

        for (const terminal of this.open.values()) {
            if (!terminal.released) {
                count += 1;
            }
        }

        return count;
    }

    /** Starts one terminal the person allowed, and returns its id at once. */
    public async create(request: TerminalStart): Promise<string> {
        if (this.live >= MAX_SESSION_TERMINALS) {
            throw new Error(`at most ${String(MAX_SESSION_TERMINALS)} terminals at once; release one first`);
        }

        const handle = await this.host.start(request);
        const terminalId = `term_${randomUUID()}`;
        const terminal: OpenTerminal = { handle, released: false };

        this.open.set(terminalId, terminal);
        this.watch(terminalId, terminal);

        return terminalId;
    }

    /** What the command printed and, once it ended, how. */
    public output(terminalId: string): TerminalOutput {
        const terminal = this.require(terminalId);

        if (terminal.released) {
            throw new RpcError(INVALID_PARAMS, "that terminal was released");
        }

        return this.host.output(terminal.handle);
    }

    public async waitForExit(terminalId: string): Promise<TerminalExitStatus> {
        const terminal = this.require(terminalId);

        if (terminal.ended !== undefined) {
            return terminal.ended.exit;
        }

        return await this.host.wait(terminal.handle);
    }

    public kill(terminalId: string): void {
        const terminal = this.require(terminalId);

        if (!terminal.released) {
            this.host.kill(terminal.handle);
        }
    }

    /** Kills the command if it still runs and frees the terminal. Its result stays for the tool row. */
    public release(terminalId: string): void {
        const terminal = this.require(terminalId);

        if (!terminal.released) {
            terminal.released = true;
            this.host.release(terminal.handle);
        }

        this.prune();
    }

    /** How a terminal the session made ended, and what it printed; undefined while it runs or for an id it never made. */
    public result(terminalId: string): OpenTerminal["ended"] {
        return this.open.get(terminalId)?.ended;
    }

    /** The turn was cancelled: every command still running is killed. */
    public killAll(): void {
        for (const terminal of this.open.values()) {
            if (!terminal.released && terminal.ended === undefined) {
                this.host.kill(terminal.handle);
            }
        }
    }

    /** The session ended: every terminal is killed and freed. */
    public releaseAll(): void {
        for (const terminal of this.open.values()) {
            if (terminal.released) {
                continue;
            }

            terminal.released = true;

            try {
                this.host.release(terminal.handle);
            } catch {
                // The core forgot it already (it was stopped); there is nothing left to free.
            }
        }
    }

    /** Forgets the oldest results of terminals that ended and were released, past the last {@link KEPT_RESULTS}. */
    private prune(): void {
        const done = [...this.open].filter(([, terminal]) => terminal.released && terminal.ended !== undefined);

        const oldest = done.slice(0, Math.max(0, done.length - KEPT_RESULTS));

        for (const [terminalId] of oldest) {
            this.open.delete(terminalId);
        }
    }

    private require(terminalId: unknown): OpenTerminal {
        const terminal = typeof terminalId === "string" ? this.open.get(terminalId) : undefined;

        if (terminal === undefined) {
            throw new RpcError(INVALID_PARAMS, "no such terminal");
        }

        return terminal;
    }

    /** Records how the command ended (its output is read now, before a release can free it) and says so. */
    private async watch(terminalId: string, terminal: OpenTerminal): Promise<void> {
        try {
            const exit = await this.host.wait(terminal.handle);
            let output = "";

            try {
                output = this.host.output(terminal.handle).output;
            } catch {
                // Released in the meantime: the row shows how it ended without what it printed.
            }

            const current = this.open.get(terminalId);

            if (current !== undefined) {
                current.ended = { exit, output };
                this.ended(terminalId);
                this.prune();
            }
        } catch {
            // The core no longer has it (stopped on quit): nothing will show it.
        }
    }
}
