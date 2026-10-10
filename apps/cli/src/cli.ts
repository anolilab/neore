import type { ParsedCommand } from "./args";
import { parseCommand, UsageError } from "./args";
import { EXIT, exitCodeFor } from "./client";
import type { Context } from "./commands";
import {
    chat,
    doctor,
    kbList,
    kbSearch,
    kbUpload,
    login,
    logout,
    models,
    reportError,
    skillsList,
    skillsRun,
    tasksCreate,
    tasksList,
    tasksRun,
    tasksStatus,
    threadsList,
    threadsRm,
    threadsShow,
    whoami,
} from "./commands";

export const VERSION = "0.1.0";

export const HELP = `neore — the Neore API from your terminal

Usage: neore <command> [options]

Account
  login [--api-url URL] [--key KEY]   Save an API key (prompted, or piped on stdin)
  logout                              Forget the saved key
  whoami                              Show the key's user and scopes
  doctor                              Check config, connectivity and the key

Chat
  chat [prompt]                       Send a prompt and stream the reply;
                                      no prompt opens an interactive session
      -m, --model ID   -t, --thread ID   --no-stream   --reasoning
  models                              List models

Threads
  threads ls [--limit N] [--cursor C] [--all]
  threads show <thread-id>
  threads rm <thread-id> [--yes]

Skills
  skills ls
  skills run <slug> [input] [-i INPUT] [-m MODEL] [-t THREAD]

Tasks
  tasks ls
  tasks create --title T --instructions I [--criteria C] [--cron EXPR] [--skill ID] [-m MODEL]
  tasks run <task-id>
  tasks status <task-id>

Knowledge base
  kb upload <file> [--type MIME]
  kb ls
  kb search <query>

Global options
  --json            Machine-readable output (NDJSON for streams)
  --api-url URL     Override the API URL      (env NEORE_API_URL)
  --api-key KEY     Override the saved key    (env NEORE_API_KEY)
  -h, --help        Show this help
  -v, --version     Show the version

Prefer the prompt or stdin over --key: flags end up in shell history.

Exit codes: 0 ok, 1 error, 2 usage, 3 auth/scope, 4 not found, 5 rate/daily limit, 6 network.
`;

type Handler = (context: Context, command: ParsedCommand) => Promise<boolean | void>;

const HANDLERS: Record<string, Handler> = {
    chat,
    doctor,
    "kb ls": kbList,
    "kb search": kbSearch,
    "kb upload": kbUpload,
    login,
    logout,
    models,
    "skills ls": skillsList,
    "skills run": skillsRun,
    "tasks create": tasksCreate,
    "tasks ls": tasksList,
    "tasks run": tasksRun,
    "tasks status": tasksStatus,
    "threads ls": threadsList,
    "threads rm": threadsRm,
    "threads show": threadsShow,
    whoami,
};

/** Run one invocation; returns the process exit code. Never throws. */
export const run = async (argv: ReadonlyArray<string>, context: Context): Promise<number> => {
    let command: ParsedCommand;

    try {
        command = parseCommand(argv);
    } catch (error) {
        reportError(context, error);

        return EXIT.usage;
    }

    if (command.flags.version) {
        context.io.stdout.write(`${VERSION}\n`);

        return EXIT.ok;
    }

    if (command.flags.help || command.command === "help") {
        context.io.stdout.write(HELP);

        return EXIT.ok;
    }

    const handler = HANDLERS[command.command];

    if (!handler) {
        context.io.stdout.write(HELP);

        return EXIT.usage;
    }

    try {
        const result = await handler(context, command);

        return result === false ? EXIT.error : EXIT.ok;
    } catch (error) {
        if (command.flags.json && !(error instanceof UsageError)) {
            const apiError = error as { code?: string; message?: string; requestId?: string };

            context.io.stdout.write(
                `${JSON.stringify({ error: { code: apiError.code ?? "error", message: apiError.message ?? String(error), requestId: apiError.requestId } })}\n`,
            );
        }

        reportError(context, error);

        return error instanceof UsageError ? EXIT.usage : exitCodeFor(error);
    }
};
