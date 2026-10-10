/**
 * The `neore` commands. Each takes the parsed command and a `Context` holding
 * everything with a side effect (I/O, fetch, the config path), so tests drive
 * them without a terminal or a network.
 */
import { basename, extname } from "node:path";

import type { Flags, ParsedCommand } from "./args";
import { limitFlag, requireArgument, UsageError } from "./args";
import { ApiError, hintFor, NeoreClient, stripTrailingSlashes } from "./client";
import type { CliConfig } from "./config";
import { deleteConfig, insecurePermissions, readConfig, resolveCredentials, writeConfig } from "./config";
import type { Io } from "./render";
import { formatDate, formatTable, paint, printJson, renderStream, shouldUseColor } from "./render";

export interface Context {
    configFile: string;
    fetch: typeof fetch;
    io: Io;
    readFile: (path: string) => Promise<Uint8Array>;
    /** One line of user input, or `null` at EOF. `secret` suppresses echo. */
    readLine: (prompt: string, options?: { secret?: boolean }) => Promise<string | null>;
    /** All of stdin, when it is piped; `null` when it is a terminal. */
    readStdin: () => Promise<string | null>;
    stdinIsTTY: boolean;
}

interface Page<T> {
    data: T[];
    nextCursor: string | null;
}

interface Thread {
    createdAt: number;
    id: string;
    model: string | null;
    title: string | null;
    updatedAt: number | null;
}

interface Message {
    createdAt: number;
    id: string;
    role: string;
    text: string;
}

interface ChatStarted {
    messageId: string;
    streamToken: string;
    threadId: string;
}

interface ChatCompleted {
    status: string;
    text: string;
    threadId: string;
}

const clientFor = async (context: Context, flags: Flags): Promise<NeoreClient> => {
    const file = await readConfig(context.configFile);
    const credentials = resolveCredentials(file, context.io.env);
    const apiKey = flags["api-key"] ?? credentials.apiKey;
    const apiUrl = flags["api-url"] ?? credentials.apiUrl;

    if (!apiUrl) {
        throw new UsageError("No API URL configured. Run `neore login --api-url <url>` or set NEORE_API_URL.");
    }

    if (!apiKey) {
        throw new UsageError("Not logged in. Run `neore login` or set NEORE_API_KEY.");
    }

    return new NeoreClient({ apiKey, baseUrl: apiUrl, fetch: context.fetch });
};

const listQuery = (flags: Flags) => {
    return { cursor: flags.cursor, limit: limitFlag(flags) };
};

/** A list, or every page of it with `--all`. */
const list = async <T>(client: NeoreClient, path: string, flags: Flags, extra: Record<string, string> = {}): Promise<Page<T>> =>
    flags.all
        ? { data: await client.listAll<T>(path, extra), nextCursor: null }
        : await client.request<Page<T>>("GET", path, { query: { ...extra, ...listQuery(flags) } });

const printNextCursor = (context: Context, page: Page<unknown>): void => {
    if (page.nextCursor) {
        context.io.stderr.write(`More results: --cursor ${page.nextCursor} (or --all)\n`);
    }
};

const CONFIRM_ANSWERS: ReadonlySet<string> = new Set(["y", "yes"]);

// ─── Chat ───────────────────────────────────────────────────────────────────

/** How long `--no-stream` waits: the server answers within 5 minutes. */
const BLOCKING_TIMEOUT_MS = 6 * 60 * 1000;

const sendPrompt = async (context: Context, client: NeoreClient, flags: Flags, path: string, body: Record<string, unknown>): Promise<{ threadId: string }> => {
    if (flags["no-stream"]) {
        const result = await client.request<ChatCompleted>("POST", path, { body: { ...body, stream: false }, timeoutMs: BLOCKING_TIMEOUT_MS });

        if (flags.json) {
            printJson(context.io, result);
        } else {
            context.io.stdout.write(result.text.endsWith("\n") ? result.text : `${result.text}\n`);
        }

        if (result.status !== "done") {
            throw new ApiError({ code: result.status, message: `The reply did not finish (${result.status}).`, status: 0 });
        }

        return { threadId: result.threadId };
    }

    const started = await client.request<ChatStarted>("POST", path, { body: { ...body, stream: true } });

    if (flags.json) {
        context.io.stdout.write(`${JSON.stringify({ messageId: started.messageId, threadId: started.threadId, type: "started" })}\n`);
    }

    await renderStream(client.stream(started.streamToken), context.io, { json: flags.json, showReasoning: flags.reasoning });

    return { threadId: started.threadId };
};

const repl = async (context: Context, client: NeoreClient, flags: Flags): Promise<void> => {
    const colors = paint(shouldUseColor(context.io.stderr, context.io.env));
    let threadId = flags.thread;

    context.io.stderr.write(colors.dim("Interactive chat. /new starts a new thread, /exit or Ctrl-D quits.\n"));

    while (true) {
        const line = await context.readLine(colors.cyan("› "));

        if (line === null || line.trim() === "/exit") {
            return;
        }

        if (line.trim() === "/new") {
            threadId = undefined;
            context.io.stderr.write(colors.dim("New thread.\n"));
            continue;
        }

        if (!line.trim()) {
            continue;
        }

        try {
            ({ threadId } = await sendPrompt(context, client, flags, "/chat", { model: flags.model, prompt: line, threadId }));
        } catch (error) {
            // One failed turn does not end the session.
            reportError(context, error);
        }
    }
};

export const chat = async (context: Context, { args, flags }: ParsedCommand): Promise<void> => {
    const client = await clientFor(context, flags);
    let prompt = args.join(" ").trim();

    if (!prompt && !context.stdinIsTTY) {
        const piped = await context.readStdin();

        prompt = piped?.trim() ?? "";
    }

    if (!prompt) {
        if (!context.stdinIsTTY) {
            throw new UsageError("No prompt given.");
        }

        await repl(context, client, flags);

        return;
    }

    const { threadId } = await sendPrompt(context, client, flags, "/chat", { model: flags.model, prompt, threadId: flags.thread });

    if (!flags.json) {
        context.io.stderr.write(paint(shouldUseColor(context.io.stderr, context.io.env)).dim(`thread ${threadId}\n`));
    }
};

// ─── Account ────────────────────────────────────────────────────────────────

export const login = async (context: Context, { flags }: ParsedCommand): Promise<void> => {
    const existing = await readConfig(context.configFile);
    const apiUrl = (
        flags["api-url"] ??
        context.io.env["NEORE_API_URL"] ??
        existing.apiUrl ??
        (await context.readLine("API URL (e.g. https://api.example.com): ")) ??
        ""
    ).trim();

    if (!apiUrl || !URL.canParse(apiUrl)) {
        throw new UsageError("An absolute API URL is required (--api-url).");
    }

    let apiKey = flags.key?.trim();

    if (!apiKey) {
        const entered = context.stdinIsTTY ? await context.readLine("Paste your API key: ", { secret: true }) : await context.readStdin();

        apiKey = entered?.trim();
    }

    if (!apiKey) {
        throw new UsageError("No API key given. Create one in Settings → API keys.");
    }

    // Verify BEFORE saving, so a typo never replaces a working key.
    const me = await new NeoreClient({ apiKey, baseUrl: apiUrl, fetch: context.fetch }).request<{ scopes: string[]; userId: string }>("GET", "/me");
    const config: CliConfig = { apiKey, apiUrl };

    await writeConfig(config, context.configFile);

    if (flags.json) {
        printJson(context.io, { apiUrl, configFile: context.configFile, scopes: me.scopes });

        return;
    }

    context.io.stdout.write(`Logged in to ${apiUrl}. Scopes: ${me.scopes.join(", ") || "none"}.\nKey saved to ${context.configFile} (mode 0600).\n`);
};

export const logout = async (context: Context, { flags }: ParsedCommand): Promise<void> => {
    await deleteConfig(context.configFile);

    if (flags.json) {
        printJson(context.io, { loggedOut: true });
    } else {
        context.io.stdout.write("Logged out. The key itself is still valid — revoke it in Settings → API keys if it leaked.\n");
    }
};

export const whoami = async (context: Context, { flags }: ParsedCommand): Promise<void> => {
    const client = await clientFor(context, flags);
    const me = await client.request<{ apiKeyId: string; scopes: string[]; userId: string }>("GET", "/me");

    if (flags.json) {
        printJson(context.io, me);
    } else {
        context.io.stdout.write(`user ${me.userId}\nkey  ${me.apiKeyId}\nscopes ${me.scopes.join(", ")}\n`);
    }
};

interface Check {
    detail: string;
    name: string;
    ok: boolean;
}

/** Everything that stands between the user and a working CLI, checked in order. Exit 1 if any fails. */
export const doctor = async (context: Context, { flags }: ParsedCommand): Promise<boolean> => {
    const checks: Check[] = [];
    const file = await readConfig(context.configFile).catch((error: unknown) => {
        checks.push({ detail: error instanceof Error ? error.message : String(error), name: "config", ok: false });

        return {};
    });
    const credentials = resolveCredentials(file, context.io.env);
    const apiUrl = flags["api-url"] ?? credentials.apiUrl;
    const apiKey = flags["api-key"] ?? credentials.apiKey;
    const perms = await insecurePermissions(context.configFile);

    checks.push(
        perms
            ? { detail: `${context.configFile} is mode ${perms}; run: chmod 600 "${context.configFile}"`, name: "config permissions", ok: false }
            : { detail: context.configFile, name: "config permissions", ok: true },
        { detail: apiUrl ?? "not set (neore login --api-url, or NEORE_API_URL)", name: "api url", ok: Boolean(apiUrl) },
        { detail: apiKey ? `${apiKey.slice(0, 6)}…` : "not set (neore login, or NEORE_API_KEY)", name: "api key", ok: Boolean(apiKey) },
    );

    if (apiUrl) {
        const started = Date.now();

        try {
            const response = await context.fetch(`${stripTrailingSlashes(apiUrl)}/api/v1/openapi.json`, { signal: AbortSignal.timeout(15_000) });
            const spec = response.ok ? ((await response.json()) as { info?: { version?: string } }) : undefined;

            checks.push({
                detail: response.ok ? `API ${spec?.info?.version ?? "?"} in ${String(Date.now() - started)}ms` : `HTTP ${String(response.status)}`,
                name: "connectivity",
                ok: response.ok,
            });
        } catch (error) {
            checks.push({ detail: error instanceof Error ? error.message : String(error), name: "connectivity", ok: false });
        }
    }

    if (apiUrl && apiKey) {
        try {
            const me = await new NeoreClient({ apiKey, baseUrl: apiUrl, fetch: context.fetch, retries: 0 }).request<{ scopes: string[] }>("GET", "/me");

            checks.push({ detail: `valid; scopes: ${me.scopes.join(", ") || "none"}`, name: "key", ok: true });
        } catch (error) {
            checks.push({ detail: error instanceof ApiError ? `${error.code}: ${error.message}` : String(error), name: "key", ok: false });
        }
    }

    const isOk = checks.every((check) => check.ok);

    if (flags.json) {
        printJson(context.io, { checks, ok: isOk });
    } else {
        const colors = paint(shouldUseColor(context.io.stdout, context.io.env));

        for (const check of checks) {
            context.io.stdout.write(`${check.ok ? colors.green("✓") : colors.red("✗")} ${check.name.padEnd(18)} ${check.detail}\n`);
        }
    }

    return isOk;
};

// ─── Resources ──────────────────────────────────────────────────────────────

export const models = async (context: Context, { flags }: ParsedCommand): Promise<void> => {
    const client = await clientFor(context, flags);
    const page = await client.request<Page<{ chat: boolean; id: string; mode: string; name: string; provider: string }>>("GET", "/models");

    if (flags.json) {
        printJson(context.io, page.data);

        return;
    }

    context.io.stdout.write(
        formatTable([
            ["ID", "NAME", "PROVIDER", "MODE"],
            ...page.data.map((model) => [model.id, model.name, model.provider, model.chat ? "chat" : model.mode]),
        ]),
    );
};

export const threadsList = async (context: Context, { flags }: ParsedCommand): Promise<void> => {
    const page = await list<Thread>(await clientFor(context, flags), "/threads", flags);

    if (flags.json) {
        printJson(context.io, page);

        return;
    }

    context.io.stdout.write(
        formatTable([
            ["ID", "UPDATED", "TITLE"],
            ...page.data.map((thread) => [thread.id, formatDate(thread.updatedAt ?? thread.createdAt), thread.title ?? "(untitled)"]),
        ]),
    );
    printNextCursor(context, page);
};

export const threadsShow = async (context: Context, { args, flags }: ParsedCommand): Promise<void> => {
    const client = await clientFor(context, flags);
    const id = requireArgument(args, "thread-id");
    const [thread, messages] = await Promise.all([
        client.request<Thread>("GET", `/threads/${encodeURIComponent(id)}`),
        client.listAll<Message>(`/threads/${encodeURIComponent(id)}/messages`, {}, 500),
    ]);
    // The API pages newest first; a transcript reads oldest first.
    const ordered = messages.toReversed();

    if (flags.json) {
        printJson(context.io, { ...thread, messages: ordered });

        return;
    }

    const colors = paint(shouldUseColor(context.io.stdout, context.io.env));

    context.io.stdout.write(`${colors.bold(thread.title ?? "(untitled)")}  ${colors.dim(thread.id)}\n\n`);

    for (const message of ordered) {
        context.io.stdout.write(`${colors.cyan(message.role)} ${colors.dim(formatDate(message.createdAt))}\n${message.text}\n\n`);
    }
};

export const threadsRm = async (context: Context, { args, flags }: ParsedCommand): Promise<void> => {
    const id = requireArgument(args, "thread-id");

    if (!flags.yes) {
        if (!context.stdinIsTTY) {
            throw new UsageError("Refusing to delete without confirmation; pass --yes.");
        }

        const answer = await context.readLine(`Delete thread ${id} permanently? [y/N] `);

        if (!CONFIRM_ANSWERS.has(answer?.trim().toLowerCase() ?? "")) {
            context.io.stderr.write("Aborted.\n");

            return;
        }
    }

    const client = await clientFor(context, flags);
    const result = await client.request<{ deleted: boolean; id: string }>("DELETE", `/threads/${encodeURIComponent(id)}`);

    if (flags.json) {
        printJson(context.io, result);
    } else {
        context.io.stdout.write(`Deleted ${id}.\n`);
    }
};

export const skillsList = async (context: Context, { flags }: ParsedCommand): Promise<void> => {
    const page = await list<{ description: string; enabled: boolean; id: string; name: string; slug: string }>(
        await clientFor(context, flags),
        "/skills",
        flags,
    );

    if (flags.json) {
        printJson(context.io, page);

        return;
    }

    context.io.stdout.write(
        formatTable([
            ["SLUG", "NAME", "ENABLED", "DESCRIPTION"],
            ...page.data.map((skill) => [skill.slug, skill.name, skill.enabled ? "yes" : "no", skill.description]),
        ]),
    );
    printNextCursor(context, page);
};

export const skillsRun = async (context: Context, { args, flags }: ParsedCommand): Promise<void> => {
    const client = await clientFor(context, flags);
    const skill = requireArgument(args, "skill");
    const input = flags.input ?? args.slice(1).join(" ");
    const { threadId } = await sendPrompt(context, client, flags, `/skills/${encodeURIComponent(skill)}/run`, {
        input: input || undefined,
        model: flags.model,
        threadId: flags.thread,
    });

    if (!flags.json) {
        context.io.stderr.write(paint(shouldUseColor(context.io.stderr, context.io.env)).dim(`thread ${threadId}\n`));
    }
};

interface Task {
    cronExpression: string | null;
    id: string;
    lastError: string | null;
    lastRunThreadId: string | null;
    nextRunAt: number | null;
    resultSummary: string | null;
    runs?: { finalAnswer: string | null; round: number; startedAt: number; status: string }[];
    status: string;
    title: string;
}

export const tasksList = async (context: Context, { flags }: ParsedCommand): Promise<void> => {
    const page = await list<Task>(await clientFor(context, flags), "/tasks", flags);

    if (flags.json) {
        printJson(context.io, page);

        return;
    }

    context.io.stdout.write(
        formatTable([["ID", "STATUS", "SCHEDULE", "TITLE"], ...page.data.map((task) => [task.id, task.status, task.cronExpression ?? "-", task.title])]),
    );
    printNextCursor(context, page);
};

export const tasksCreate = async (context: Context, { args, flags }: ParsedCommand): Promise<void> => {
    const title = flags.title ?? args.join(" ");
    const instructions = flags.instructions ?? (context.stdinIsTTY ? undefined : ((await context.readStdin()) ?? undefined));

    if (!title.trim()) {
        throw new UsageError("--title is required.");
    }

    if (!instructions?.trim()) {
        throw new UsageError("--instructions is required (or pipe them on stdin).");
    }

    const client = await clientFor(context, flags);
    const result = await client.request<{ id: string }>("POST", "/tasks", {
        body: {
            cronExpression: flags.cron,
            instructions: instructions.trim(),
            model: flags.model,
            skillId: flags.skill,
            successCriteria: flags.criteria,
            title: title.trim(),
        },
    });

    if (flags.json) {
        printJson(context.io, result);
    } else {
        context.io.stdout.write(`Created task ${result.id}. Start it with: neore tasks run ${result.id}\n`);
    }
};

export const tasksRun = async (context: Context, { args, flags }: ParsedCommand): Promise<void> => {
    const id = requireArgument(args, "task-id");
    const client = await clientFor(context, flags);
    const result = await client.request<{ status: string }>("POST", `/tasks/${encodeURIComponent(id)}/run`);

    if (flags.json) {
        printJson(context.io, { id, ...result });
    } else {
        context.io.stdout.write(`Task ${id}: ${result.status}. Follow it with: neore tasks status ${id}\n`);
    }
};

export const tasksStatus = async (context: Context, { args, flags }: ParsedCommand): Promise<void> => {
    const id = requireArgument(args, "task-id");
    const client = await clientFor(context, flags);
    const task = await client.request<Task>("GET", `/tasks/${encodeURIComponent(id)}`);

    if (flags.json) {
        printJson(context.io, task);

        return;
    }

    const lines = [
        `${task.title}  (${task.status})`,
        task.cronExpression ? `schedule  ${task.cronExpression}, next ${formatDate(task.nextRunAt)}` : undefined,
        task.lastRunThreadId ? `thread    ${task.lastRunThreadId}` : undefined,
        task.lastError ? `error     ${task.lastError}` : undefined,
        task.resultSummary ? `\n${task.resultSummary}` : undefined,
    ].filter(Boolean);

    context.io.stdout.write(`${lines.join("\n")}\n`);

    if (task.runs?.length) {
        context.io.stdout.write(
            `\n${formatTable([["ROUND", "STARTED", "STATUS"], ...task.runs.map((run) => [String(run.round), formatDate(run.startedAt), run.status])])}`,
        );
    }
};

const MIME_BY_EXTENSION: Record<string, string> = {
    ".csv": "text/csv",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".htm": "text/html",
    ".html": "text/html",
    ".json": "application/json",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export const guessMimeType = (path: string): string | undefined => MIME_BY_EXTENSION[extname(path).toLowerCase()];

export const kbUpload = async (context: Context, { args, flags }: ParsedCommand): Promise<void> => {
    const path = requireArgument(args, "file");
    const mimeType = flags.type ?? guessMimeType(path);

    if (!mimeType) {
        throw new UsageError(`Cannot tell the type of ${basename(path)}; pass --type <mime>.`);
    }

    const client = await clientFor(context, flags);
    const bytes = await context.readFile(path);
    const name = basename(path);
    const uploadId = await client.upload(bytes, { mimeType, name });
    const file = await client.request<{ id: string; status: string }>("POST", "/knowledge/files", { body: { name, uploadId } });

    if (flags.json) {
        printJson(context.io, file);
    } else {
        context.io.stdout.write(`Uploaded ${name} (${file.id}); indexing. Check with: neore kb ls\n`);
    }
};

export const kbList = async (context: Context, { flags }: ParsedCommand): Promise<void> => {
    const page = await list<{ id: string; name: string; size: number; status: string }>(await clientFor(context, flags), "/knowledge/files", flags);

    if (flags.json) {
        printJson(context.io, page);

        return;
    }

    context.io.stdout.write(formatTable([["ID", "STATUS", "SIZE", "NAME"], ...page.data.map((file) => [file.id, file.status, String(file.size), file.name])]));
    printNextCursor(context, page);
};

export const kbSearch = async (context: Context, { args, flags }: ParsedCommand): Promise<void> => {
    const query = args.join(" ").trim();

    if (!query) {
        throw new UsageError("Missing <query>.");
    }

    const client = await clientFor(context, flags);
    const page = await client.request<Page<{ content: string; fileName: string; score: number }>>("GET", "/knowledge/search", { query: { q: query } });

    if (flags.json) {
        printJson(context.io, page.data);

        return;
    }

    if (page.data.length === 0) {
        context.io.stdout.write("No matches.\n");

        return;
    }

    const colors = paint(shouldUseColor(context.io.stdout, context.io.env));

    for (const hit of page.data) {
        context.io.stdout.write(`${colors.bold(hit.fileName)} ${colors.dim(hit.score.toFixed(3))}\n${hit.content.trim()}\n\n`);
    }
};

export const reportError = (context: Context, error: unknown): void => {
    const colors = paint(shouldUseColor(context.io.stderr, context.io.env));

    if (error instanceof UsageError) {
        context.io.stderr.write(`${colors.red("error:")} ${error.message}\n`);

        return;
    }

    if (error instanceof ApiError) {
        context.io.stderr.write(`${colors.red(`error [${error.code}]:`)} ${error.message}\n`);

        const hint = hintFor(error);

        if (hint) {
            context.io.stderr.write(`${colors.yellow("hint:")} ${hint}\n`);
        }

        if (error.requestId) {
            context.io.stderr.write(colors.dim(`request id ${error.requestId}\n`));
        }

        return;
    }

    context.io.stderr.write(`${colors.red("error:")} ${error instanceof Error ? error.message : String(error)}\n`);
};
