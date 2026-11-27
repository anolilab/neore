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
    device: { type: "boolean" },
    effort: { type: "string" },
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
    wait: { type: "boolean" },
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
    thread: ["start", "send"],
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

/** The commands `--wait` blocks; every flag is shared, so any other command would silently drop it. */
const WAIT_COMMANDS: ReadonlySet<string> = new Set(["thread send", "thread start"]);

/** The blocking flag of a command that has one instead of `--wait`. */
const WAIT_INSTEAD: Readonly<Record<string, string>> = { chat: "--no-stream", "skills run": "--no-stream", "tasks run": "`neore tasks status <id>`" };

/** The commands `--effort` reaches: the two that send one prompt to a thread. Any other would drop it while a billed run starts. */
const EFFORT_COMMANDS: ReadonlySet<string> = WAIT_COMMANDS;

const refuseEffortElsewhere = ({ command, flags }: ParsedCommand): void => {
    if (flags.effort !== undefined && !flags.help && !EFFORT_COMMANDS.has(command)) {
        throw new UsageError(`\`${command}\` has no --effort. It is for \`thread start\` and \`thread send\`.`);
    }
};

export const parseCommand = (argv: ReadonlyArray<string>): ParsedCommand => {
    const parsed = parseWords(argv);

    refuseEffortElsewhere(parsed);

    if (parsed.flags.wait && !parsed.flags.help && !WAIT_COMMANDS.has(parsed.command)) {
        const instead = WAIT_INSTEAD[parsed.command];

        throw new UsageError(`\`${parsed.command}\` has no --wait${instead ? `: use ${instead}` : ""}. It is for \`thread start\` and \`thread send\`.`);
    }

    return parsed;
};

const parseWords = (argv: ReadonlyArray<string>): ParsedCommand => {
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
            if (flags.help) {
                return { args: [], command: "help", flags };
            }

            if (!(GROUPS[head] as ReadonlyArray<string>).includes("ls")) {
                throw new UsageError(`Missing subcommand. Try: ${GROUPS[head].map((name) => `${head} ${name}`).join(", ")}.`);
            }

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

const EFFORT_DIGITS = /^\d{1,3}$/u;

/** `--effort` as an integer in 0..100, the scale of the app's reasoning-effort slider. */
export const effortFlag = (flags: Flags): number | undefined => {
    if (flags.effort === undefined) {
        return undefined;
    }

    // Digits only: `1e2`, ` 5` and `0x10` are numbers to `Number` but not what a person typed as a level.
    const value = Number(flags.effort);

    if (!EFFORT_DIGITS.test(flags.effort) || value > 100) {
        throw new UsageError("--effort must be an integer between 0 and 100.");
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
