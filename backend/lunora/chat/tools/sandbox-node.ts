import path from "node:path";

/**
 * Sandbox Node Action
 *
 * Internal action that manages E2B sandbox sessions and executes commands.
 * Sessions persist across tool calls within the same thread for continuity.
 * Follows the browserNode.ts pattern.
 */
import type { Sandbox } from "e2b";
import { LunoraError, v } from "lunorash/server";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { internalAction } from "../../_generated/server";
import { storeFile } from "../../agent/client/files";
import { E2B_API_KEY } from "../../env";
import type { OutputSnapshot, SandboxOutputs } from "./sandbox-outputs";
import { collectSandboxOutputs, MAX_OUTPUT_FILE_BYTES, sandboxOutputContentTypes, snapshotSandboxOutputs } from "./sandbox-outputs";

("use node");

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes idle timeout
const MAX_COMMAND_TIMEOUT_MS = 300_000; // 5 minutes max per command
const MAX_OUTPUT_LENGTH = 50_000; // Truncate stdout/stderr

/** Audit-log action name per file operation; anything else logs as a write. */
const FILE_ACTION_BY_OPERATION: Record<string, "deleteFile" | "listDir" | "readFile" | "writeFile"> = {
    create: "writeFile",
    delete: "deleteFile",
    list: "listDir",
    read: "readFile",
};

const truncate = (text: string, maxLength = MAX_OUTPUT_LENGTH): string => {
    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, maxLength)}\n... (truncated, ${text.length - maxLength} chars omitted)`;
};

/**
 * Get or create a sandbox session for the given thread.
 * Returns the E2B sandbox instance and the session ID.
 */
const getOrCreateSandbox = async (
    context: any,
    userId: string,
    threadId: Id<"threads">,
): Promise<{ isNew: boolean; sandbox: Sandbox; sessionId: Id<"sandboxSessions"> }> => {
    if (!E2B_API_KEY) {
        throw new Error("E2B_API_KEY is not configured. Please set it to use sandbox features.");
    }

    // Check for existing active session
    const existingSession = await context.runQuery(internal.sandbox.functions.getActiveSession, {
        threadId,
    });

    if (existingSession?.sandboxId) {
        try {
            const { Sandbox } = await import("e2b");
            const sandbox = await Sandbox.connect(existingSession.sandboxId, {
                apiKey: E2B_API_KEY,
            });

            // Update last activity
            await context.runMutation(internal.sandbox.functions.updateSession, {
                sessionId: existingSession._id,
            });

            return { isNew: false, sandbox, sessionId: existingSession._id };
        } catch {
            // Session expired or sandbox was terminated — close it and create a new one
            await context.runMutation(internal.sandbox.functions.closeSession, {
                errorMessage: "Sandbox no longer available, creating new session",
                sessionId: existingSession._id,
                status: "terminated",
            });
        }
    }

    // Create a new sandbox
    const sessionId = await context.runMutation(internal.sandbox.functions.createSession, {
        threadId,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        userId,
    });

    const { Sandbox } = await import("e2b");
    const sandbox = await Sandbox.create({
        apiKey: E2B_API_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
    });

    // Update session with sandbox ID and mark active
    await context.runMutation(internal.sandbox.functions.updateSession, {
        sandboxId: sandbox.sandboxId,
        sessionId,
        status: "active",
    });

    // Schedule idle cleanup
    const cleanupFunctionId = await context.scheduler.runAfter(DEFAULT_TIMEOUT_MS + 10_000, internal.sandbox.cleanup.checkAndTerminateSandbox, { sessionId });

    await context.runMutation(internal.sandbox.functions.updateSession, {
        cleanupFnId: String(cleanupFunctionId),
        sessionId,
    });

    return { isNew: true, sandbox, sessionId };
};

const NO_OUTPUTS: SandboxOutputs = { files: [], skippedFiles: [] };

/** Snapshot the output directory before a run. A failure only means nothing is collected afterwards. */
const snapshotOutputs = async (sandbox: Sandbox): Promise<OutputSnapshot | null> => await snapshotSandboxOutputs(sandbox).catch(() => null);

/**
 * Store what the run wrote to the output directory as chat files the caller
 * (and the thread's owner) hold grants for — see `sandbox-outputs.ts`.
 */
const collectOutputs = async (
    context: ActionCtx,
    sandbox: Sandbox,
    before: OutputSnapshot | null,
    { threadId, userId }: { threadId: Id<"threads">; userId: string },
): Promise<SandboxOutputs> => {
    if (!before) {
        return NO_OUTPUTS;
    }

    return await collectSandboxOutputs(sandbox, before, async (bytes, { mediaType, name }) => {
        const { file } = await storeFile(context, new Blob([new Uint8Array(bytes)], { type: mediaType }), {
            allowedContentTypes: sandboxOutputContentTypes(),
            filename: name,
            maxSize: MAX_OUTPUT_FILE_BYTES,
            threadId,
            userId,
        });

        return file.storageId;
    }).catch(() => NO_OUTPUTS);
};

export const executeShellCommand = internalAction
    .input({
        command: v.string(),
        threadId: v.id("threads"),
        timeoutMs: v.optional(v.number()),
        userId: v.string(),
        workingDir: v.optional(v.string()),
    })
    .action(async ({ args: { command, threadId, timeoutMs, userId, workingDir }, ctx }) => {
        const startTime = Date.now();

        const { sandbox, sessionId } = await getOrCreateSandbox(ctx, userId, threadId);

        try {
            const effectiveTimeout = Math.min(timeoutMs ?? MAX_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS);
            const outputsBefore = await snapshotOutputs(sandbox);

            const result = await sandbox.commands.run(command, {
                cwd: workingDir ?? "/home/user",
                timeoutMs: effectiveTimeout,
            });

            const stdout = truncate(result.stdout);
            const stderr = truncate(result.stderr);
            const durationMs = Date.now() - startTime;

            // Log the action
            await ctx.runMutation(internal.sandbox.functions.logAction, {
                action: "shell",
                command: command.slice(0, 10_000),
                durationMs,
                exitCode: result.exitCode,
                sessionId,
                stderr,
                stdout,
                success: result.exitCode === 0,
            });

            return {
                exitCode: result.exitCode,
                stderr,
                stdout,
                ...(await collectOutputs(ctx, sandbox, outputsBefore, { threadId, userId })),
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const durationMs = Date.now() - startTime;

            await ctx.runMutation(internal.sandbox.functions.logAction, {
                action: "shell",
                command: command.slice(0, 10_000),
                durationMs,
                sessionId,
                stderr: errorMessage,
                success: false,
            });

            return {
                error: errorMessage,
                exitCode: 1,
                stderr: errorMessage,
                stdout: "",
            };
        }
    });

export const executeCode = internalAction
    .input({
        code: v.string(),
        threadId: v.id("threads"),
        timeoutMs: v.optional(v.number()),
        userId: v.string(),
    })
    .action(async ({ args: { code, threadId, timeoutMs, userId }, ctx }) => {
        const startTime = Date.now();

        const { sandbox, sessionId } = await getOrCreateSandbox(ctx, userId, threadId);

        try {
            const effectiveTimeout = Math.min(timeoutMs ?? MAX_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS);

            const outputsBefore = await snapshotOutputs(sandbox);

            // Write the code to a temp file and execute it with Python
            const temporaryFile = `/tmp/code_${Date.now()}.py`;

            await sandbox.files.write(temporaryFile, code);

            const result = await sandbox.commands.run(`python3 ${temporaryFile}`, {
                cwd: "/home/user",
                timeoutMs: effectiveTimeout,
            });

            const stdout = truncate(result.stdout);
            const stderr = truncate(result.stderr);
            const durationMs = Date.now() - startTime;

            await ctx.runMutation(internal.sandbox.functions.logAction, {
                action: "runCode",
                command: `python3 (${code.length} chars)`,
                durationMs,
                exitCode: result.exitCode,
                sessionId,
                stderr,
                stdout,
                success: result.exitCode === 0,
            });

            return {
                error: result.exitCode === 0 ? undefined : stderr || `Process exited with code ${result.exitCode}`,
                results: stdout ? [{ type: "text" as const, value: stdout }] : [],
                stderr,
                stdout,
                ...(await collectOutputs(ctx, sandbox, outputsBefore, { threadId, userId })),
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const durationMs = Date.now() - startTime;

            await ctx.runMutation(internal.sandbox.functions.logAction, {
                action: "runCode",
                command: `python3 (${code.length} chars)`,
                durationMs,
                sessionId,
                stderr: errorMessage,
                success: false,
            });

            return {
                error: errorMessage,
                results: [{ type: "error" as const, value: errorMessage }],
                stderr: "",
                stdout: "",
            };
        }
    });

/**
 * What a file operation reports back.
 *
 * Declared here, where the action produces it, and imported by the tool that
 * consumes it. It used to live only in `chat/tools/fileOperations.ts`, which then
 * had to write `(await runAction(...)) as FileOperationResult` — and that cast
 * could not even be made, because the action's inferred return is
 * `Record<string, unknown>` and the two do not overlap. Naming the handler's
 * return type is what actually fixes it: the generated reference takes its Return
 * from the HANDLER, never from `.output()`.
 */
export interface FileOperationResult {
    bytesWritten?: number;
    content?: string;
    endLine?: number;
    error?: string;
    path?: string;
    startLine?: number;
    success: boolean;
    totalLines?: number;
}

export const executeFileOperation = internalAction
    .input({
        content: v.optional(v.string()),
        endLine: v.optional(v.number()),
        newString: v.optional(v.string()),
        oldString: v.optional(v.string()),
        operation: v.string(), // "create" | "read" | "edit" | "delete" | "list"
        path: v.string(),
        startLine: v.optional(v.number()),
        threadId: v.id("threads"),
        userId: v.string(),
    })
    .action(async ({ args, ctx }): Promise<FileOperationResult> => {
        const { operation, path: innerPath, threadId, userId } = args;
        const startTime = Date.now();

        // Path sanitization: ensure all operations stay within /home/user
        const safePath = sanitizePath(innerPath);

        const { sandbox, sessionId } = await getOrCreateSandbox(ctx, userId, threadId);

        try {
            let result: FileOperationResult;

            switch (operation) {
                case "create": {
                    if (!args.content) {
                        throw new LunoraError("BAD_REQUEST", "Content is required for create operation");
                    }

                    await sandbox.files.write(safePath, args.content);
                    result = { bytesWritten: args.content.length, path: safePath, success: true };
                    break;
                }

                case "delete": {
                    // Use the E2B Filesystem API directly — never shell out with
                    // an interpolated path. `sanitizePath` cannot strip shell
                    // metacharacters (`"`, `$`, backticks), so a path like
                    // `foo"; rm -rf /; "bar` would survive `path.resolve` and
                    // execute as a command if interpolated into `rm -f "..."`.
                    await sandbox.files.remove(safePath);
                    result = { path: safePath, success: true };
                    break;
                }

                case "edit": {
                    if (!args.oldString || args.newString === undefined) {
                        throw new LunoraError("BAD_REQUEST", "oldString and newString are required for edit operation");
                    }

                    const fileContent = await sandbox.files.read(safePath);
                    const textContent = typeof fileContent === "string" ? fileContent : new TextDecoder().decode(fileContent as ArrayBuffer);

                    // Count occurrences
                    const occurrences = textContent.split(args.oldString).length - 1;

                    if (occurrences === 0) {
                        result = {
                            error: `String not found in file: "${args.oldString.slice(0, 100)}"`,
                            path: safePath,
                            success: false,
                        };
                    } else if (occurrences > 1) {
                        result = {
                            error: `String found ${occurrences} times — must be unique. Provide more context to make the match unique.`,
                            path: safePath,
                            success: false,
                        };
                    } else {
                        // Function replacement: `args.newString` comes from the
                        // model and a `$&` in it would splice the matched text
                        // back in instead of being written literally. Bound to a
                        // const first — the guard above narrows it to `string`,
                        // but that narrowing does not survive into a closure.
                        const replacement = args.newString;
                        const newContent = textContent.replace(args.oldString, () => replacement);

                        await sandbox.files.write(safePath, newContent);
                        result = { path: safePath, success: true };
                    }

                    break;
                }

                case "list": {
                    // Same reasoning: use the typed list API instead of `ls`
                    // with a quoted argument, which is a command-injection
                    // sink for any path containing shell metacharacters.
                    const entries = await sandbox.files.list(safePath);
                    const formatted = entries.map((entry) => `${entry.type === "dir" ? "d" : "-"} ${entry.name}`).join("\n");

                    result = {
                        content: truncate(formatted),
                        path: safePath,
                        success: true,
                    };
                    break;
                }

                case "read": {
                    const content = await sandbox.files.read(safePath);
                    const text = typeof content === "string" ? content : new TextDecoder().decode(content as ArrayBuffer);

                    // Apply line range if specified
                    if (args.startLine !== undefined || args.endLine !== undefined) {
                        const lines = text.split("\n");
                        const start = (args.startLine ?? 1) - 1;
                        const end = args.endLine ?? lines.length;
                        const sliced = lines.slice(Math.max(0, start), end).join("\n");

                        result = {
                            content: truncate(sliced),
                            endLine: Math.min(end, lines.length),
                            path: safePath,
                            startLine: start + 1,
                            success: true,
                            totalLines: lines.length,
                        };
                    } else {
                        result = {
                            content: truncate(text),
                            path: safePath,
                            success: true,
                            totalLines: text.split("\n").length,
                        };
                    }

                    break;
                }

                default: {
                    throw new LunoraError("BAD_REQUEST", `Unknown file operation: ${operation}`);
                }
            }

            const durationMs = Date.now() - startTime;

            await ctx.runMutation(internal.sandbox.functions.logAction, {
                action: FILE_ACTION_BY_OPERATION[operation] ?? "writeFile",
                command: safePath,
                durationMs,
                sessionId,
                success: result.success,
            });

            return result;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const durationMs = Date.now() - startTime;

            await ctx.runMutation(internal.sandbox.functions.logAction, {
                action: operation === "list" ? "listDir" : "readFile",
                command: safePath,
                durationMs,
                sessionId,
                stderr: errorMessage,
                success: false,
            });

            return {
                error: errorMessage,
                path: safePath,
                success: false,
            };
        }
    });

/**
 * Sanitize a file path to prevent directory traversal outside /home/user.
 */
const sanitizePath = (inputPath: string): string => {
    let raw = inputPath.trim();

    // If relative, prefix with /home/user
    if (!raw.startsWith("/")) {
        raw = `/home/user/${raw}`;
    }

    // Canonicalize via path.resolve to collapse .., //, etc.
    const normalized = path.resolve(raw);

    // Boundary check must require either an exact directory match OR a `/`
    // separator after the prefix. A bare `startsWith("/home/user")` would
    // green-light `/home/userfoo` or `/tmproot/etc/passwd` — anything sharing
    // the prefix as a literal substring.
    const inHomeUser = normalized === "/home/user" || normalized.startsWith("/home/user/");
    const inTemporary = normalized === "/tmp" || normalized.startsWith("/tmp/");

    if (!inHomeUser && !inTemporary) {
        throw new LunoraError("BAD_REQUEST", `Path must be within /home/user or /tmp. Resolved: ${normalized}`);
    }

    return normalized;
};
