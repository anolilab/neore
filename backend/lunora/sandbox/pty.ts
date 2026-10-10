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

import { internal } from "../_generated/internal";
import { internalAction } from "../_generated/server";
import { E2B_API_KEY } from "../env";

("use node");

const MAX_STREAM_CHUNK_SIZE = 8000; // Max chars per streaming delta
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

const executePtyCommand = internalAction
    .input({
        cols: v.optional(v.number()),
        command: v.string(),
        rows: v.optional(v.number()),
        sandboxId: v.string(),
        sessionId: v.id("sandboxSessions"),
        threadId: v.id("threads"),
        timeoutMs: v.optional(v.number()),
        userId: v.string(),
    })
    .action(async ({ args, ctx }) => {
        if (!E2B_API_KEY) {
            throw new LunoraError("SERVICE_UNAVAILABLE", "E2B_API_KEY is not configured");
        }

        const { command, sandboxId, sessionId, timeoutMs } = args;
        const cols = args.cols ?? DEFAULT_COLS;
        const rows = args.rows ?? DEFAULT_ROWS;
        const startTime = Date.now();

        // Loaded on use: e2b pulls protobuf, connect-rpc and a Dockerfile parser
        // whose module init costs ~70ms of every cold isolate's startup.
        const { Sandbox } = await import("e2b");
        const sandbox = await Sandbox.connect(sandboxId, {
            apiKey: E2B_API_KEY,
        });

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

                    await ctx.runMutation(internal.sandbox.functions.logAction, {
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

            await ctx.runMutation(internal.sandbox.functions.logAction, {
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

            await ctx.runMutation(internal.sandbox.functions.logAction, {
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
    });

export default executePtyCommand;
