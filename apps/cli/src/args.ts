/**
 * Argument parsing: `node:util`'s `parseArgs` over one option table, then
 * command resolution. Strict — an unknown flag is a usage error (exit 2), not
 * silently ignored, because a mistyped `--no-strem` must not start a blocking
 * run the user thought was streaming.
 */
import { parseArgs } from "node:util";

export const OPTIONS = {
    all: { type: "boolean" },
    "api-key": { type: "string" },
    "api-url": { type: "string" },
    criteria: { type: "string" },
    cron: { type: "string" },
    cursor: { type: "string" },
    help: { short: "h", type: "boolean" },
    input: { short: "i", type: "string" },
    instructions: { type: "string" },
    json: { type: "boolean" },
    key: { type: "string" },
    limit: { type: "string" },
    model: { short: "m", type: "string" },
    "no-stream": { type: "boolean" },
    reasoning: { type: "boolean" },
    skill: { type: "string" },
    thread: { short: "t", type: "string" },
    title: { type: "string" },
    type: { type: "string" },
    version: { short: "v", type: "boolean" },
    yes: { short: "y", type: "boolean" },
} as const;

export type Flags = {
    [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]["type"] extends "boolean" ? boolean : string;
};

/** Commands with subcommands, and the subcommands each accepts. */
export const GROUPS = {
    kb: ["upload", "search", "ls"],
    skills: ["ls", "run"],
    tasks: ["ls", "create", "run", "status"],
    threads: ["ls", "show", "rm"],
} as const;

export const SINGLE_COMMANDS = ["login", "logout", "chat", "models", "doctor", "help", "whoami"] as const;

export type CommandName = `${keyof typeof GROUPS} ${string}` | (typeof SINGLE_COMMANDS)[number];

export interface ParsedCommand {
    args: string[];
    command: CommandName;
    flags: Flags;
}

export class UsageError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "UsageError";
    }
}

const isGroup = (value: string): value is keyof typeof GROUPS => Object.hasOwn(GROUPS, value);

export const parseCommand = (argv: ReadonlyArray<string>): ParsedCommand => {
    let parsed: ReturnType<typeof parseArgs<{ allowPositionals: true; args: string[]; options: typeof OPTIONS; strict: true }>>;

    try {
        parsed = parseArgs({ allowPositionals: true, args: [...argv], options: OPTIONS, strict: true });
    } catch (error) {
        throw new UsageError(error instanceof Error ? error.message : String(error));
    }

    const flags = parsed.values as Flags;
    const [head, ...rest] = parsed.positionals;

    if (!head) {
        return { args: [], command: "help", flags };
    }

    if (isGroup(head)) {
        const [sub, ...args] = rest;

        if (!sub) {
            // `neore threads` alone lists, like `ls`.
            return { args: [], command: `${head} ls`, flags };
        }

        const allowed: ReadonlyArray<string> = GROUPS[head];

        if (!allowed.includes(sub)) {
            throw new UsageError(`Unknown command "${head} ${sub}". Try: ${allowed.map((name) => `${head} ${name}`).join(", ")}.`);
        }

        return { args, command: `${head} ${sub}`, flags };
    }

    if ((SINGLE_COMMANDS as ReadonlyArray<string>).includes(head)) {
        return { args: rest, command: head as (typeof SINGLE_COMMANDS)[number], flags };
    }

    throw new UsageError(`Unknown command "${head}". Run \`neore help\`.`);
};

/** `--limit` as a number in 1..100. */
export const limitFlag = (flags: Flags): number | undefined => {
    if (flags.limit === undefined) {
        return undefined;
    }

    const value = Number(flags.limit);

    if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
        throw new UsageError("--limit must be an integer between 1 and 100.");
    }

    return value;
};

export const requireArgument = (args: ReadonlyArray<string>, name: string): string => {
    const value = args[0];

    if (!value) {
        throw new UsageError(`Missing <${name}>.`);
    }

    return value;
};
