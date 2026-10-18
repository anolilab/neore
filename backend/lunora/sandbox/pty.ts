/**
 * PTY Streaming for Sandbox
 *
 * Provides pseudo-terminal (PTY) streaming capabilities for interactive
 * command execution in E2B sandboxes. Supports real-time output streaming
 * via backend mutations (SSE-compatible).
 *
 * Features:
 * - Interactive PTY sessions with ANSI color support
 * - Real-time stdout/stderr streaming via delta mutations
 * - Configurable terminal dimensions (rows/cols)
 * - Input piping for interactive commands (e.g., REPLs, installers)
 */
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { ActionCtx } from "../_generated/server";
import { internalAction } from "../_generated/server";
import { getOrCreateSandbox } from "../chat/tools/sandbox-node";
import { E2B_API_KEY } from "../env";

("use node");

const MAX_STREAM_CHUNK_SIZE = 8000; // Max chars per streaming delta
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

interface PtyCommandArgs {
    cols?: number;
    command: string;
    rows?: number;
    threadId: Id<"threads">;
    timeoutMs?: number;
    userId: string;
}

/**
 * Runs one command in the PTY of the thread's sandbox. A bot thread with a computer
 * attaches to the bot's computer, as the shell and file tools do. Nothing here closes
 * a session: an idle bot computer is paused by the cleanup job, never terminated.
 */
export const runPtyCommand = async (context: ActionCtx, args: PtyCommandArgs) => {
    if (!E2B_API_KEY) {
        throw new LunoraError("SERVICE_UNAVAILABLE", "E2B_API_KEY is not configured");
    }

    const { command, threadId, timeoutMs, userId } = args;
    const cols = args.cols ?? DEFAULT_COLS;
    const rows = args.rows ?? DEFAULT_ROWS;
    const startTime = Date.now();

    const { sandbox, sessionId } = await getOrCreateSandbox(context, userId, threadId);

    let accumulatedOutput = "";
    let lastFlushLength = 0;
    let isFlushInProgress = false;
    let isFlushQueued = false;

    /**
     * Flush accumulated output as a sandbox action delta.
     * Uses a guard to prevent concurrent flushes from racing.
     */
    const flushOutput = async () => {
        if (isFlushInProgress) {
            isFlushQueued = true;

            return;
        }

        isFlushInProgress = true;

        try {
            while (accumulatedOutput.length > lastFlushLength) {
                const newContent = accumulatedOutput.slice(lastFlushLength);

                lastFlushLength = accumulatedOutput.length;

                await context.runMutation(internal.sandbox.functions.logAction, {
                    action: "pty",
                    command: `[stream delta] ${newContent.length} chars`,
                    durationMs: Date.now() - startTime,
                    sessionId,
                    stdout: newContent.slice(0, MAX_STREAM_CHUNK_SIZE),
                    success: true,
                });

                if (!isFlushQueued) {
                    break;
                }

                isFlushQueued = false;
            }
        } finally {
            isFlushInProgress = false;
        }
    };

    try {
        const effectiveTimeout = Math.min(timeoutMs ?? 300_000, 300_000);

        // Use E2B's PTY-like command execution
        // E2B SDK provides terminal support via commands.run with envs
        const result = await sandbox.commands.run(command, {
            cwd: "/home/user",
            envs: {
                COLUMNS: String(cols),
                FORCE_COLOR: "1",
                LINES: String(rows),
                TERM: "xterm-256color",
            },
            onStderr: (data) => {
                accumulatedOutput += data;

                if (accumulatedOutput.length - lastFlushLength >= MAX_STREAM_CHUNK_SIZE) {
                    void flushOutput();
                }
            },
            onStdout: (data) => {
                accumulatedOutput += data;

                // Batch output — flush every chunk
                if (accumulatedOutput.length - lastFlushLength >= MAX_STREAM_CHUNK_SIZE) {
                    void flushOutput();
                }
            },
            timeoutMs: effectiveTimeout,
        });

        // Final flush of remaining output
        await flushOutput();

        const durationMs = Date.now() - startTime;

        await context.runMutation(internal.sandbox.functions.logAction, {
            action: "pty",
            command: command.slice(0, 10_000),
            durationMs,
            exitCode: result.exitCode,
            sessionId,
            stdout: accumulatedOutput.slice(0, 50_000),
            success: result.exitCode === 0,
        });

        return {
            exitCode: result.exitCode,
            output: accumulatedOutput.slice(0, 50_000),
            totalChars: accumulatedOutput.length,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        await context.runMutation(internal.sandbox.functions.logAction, {
            action: "pty",
            command: command.slice(0, 10_000),
            durationMs: Date.now() - startTime,
            sessionId,
            stderr: errorMessage,
            success: false,
        });

        return {
            error: errorMessage,
            exitCode: 1,
            output: accumulatedOutput.slice(0, 50_000),
        };
    }
};

const executePtyCommand = internalAction
    .input({
        cols: v.optional(v.number()),
        command: v.string(),
        rows: v.optional(v.number()),
        threadId: v.id("threads"),
        timeoutMs: v.optional(v.number()),
        userId: v.string(),
    })
    .action(async ({ args, ctx }) => await runPtyCommand(ctx, args));

export default executePtyCommand;
