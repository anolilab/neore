/**
 * Marks every tool call of a run on its stream while it executes (`markToolRun`), so a worker that dies inside a tool
 * is never resumed: the tool may have paid for or changed something and leaves no row (`interrupted-run.ts`).
 *
 * The mark is written BEFORE the tool starts and stays until the step that holds the call has been SAVED (`release`,
 * from the step's `onStepFinish`, which the agent runs after it saved the rows). A tool that has returned but whose
 * rows are not saved yet is still unaccounted for: a death in that window would otherwise look like "not in a tool" and
 * the resume would call the tool again. A refused mark (the stream ended, or a newer run holds it) stops the tool; any
 * other failure of the mark is logged and the tool runs, counted as open all the same.
 */
import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { streamLogger } from "../../lib/logger";
import { errorCodeOf, isRunReplaced } from "./run-epoch";

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
    typeof value === "object" && value !== null && Symbol.asyncIterator in (value as object);

export interface ToolRunMarker {
    /** Called once the step's rows are saved: the tools that finished in it are accounted for. Best effort, like every unmark. */
    release: () => Promise<void>;
    wrap: <T extends Record<string, unknown>>(tools: T) => T;
}

export const createToolRunMarker = (ctx: Pick<ActionCtx, "runMutation">, args: { epoch: number; onReplaced: () => void; streamId: string }): ToolRunMarker => {
    const { epoch, onReplaced, streamId } = args;
    // Tools that returned (or threw) and wait for their step to be saved.
    let finished = 0;
    const mark = async (delta: number) =>
        await ctx.runMutation(internal.chat.streaming.persistent.interrupted.markToolRun, { delta, epoch, streamId: streamId as Id<"persistentStreams"> });
    const begin = async () => {
        try {
            await mark(1);
        } catch (error) {
            if (isRunReplaced(error)) {
                onReplaced();
            }

            // A stream that ended or was taken over stops the tool; a shard blip must not, and the tool then counts as open
            // anyway (a mark that never landed is clamped at zero on release).
            if (isRunReplaced(error) || errorCodeOf(error) === "CONFLICT") {
                throw error;
            }

            streamLogger.warn(`[BgAgent] Could not mark a tool call on stream ${streamId}:`, error);
        }
    };
    const end = () => {
        finished += 1;
    };

    return {
        release: async () => {
            const count = finished;

            if (count === 0) {
                return;
            }

            finished -= count;
            await mark(-count).catch((error: unknown) => {
                if (isRunReplaced(error)) {
                    onReplaced();
                }
            });
        },
        wrap: <T extends Record<string, unknown>>(tools: T): T => {
            const marked: Record<string, unknown> = {};

            for (const [name, definition] of Object.entries(tools)) {
                const execute = (definition as { execute?: (...args: unknown[]) => unknown } | undefined)?.execute;

                if (typeof execute !== "function") {
                    marked[name] = definition;

                    continue;
                }

                marked[name] = {
                    ...(definition as object),
                    execute: async (...executeArgs: unknown[]) => {
                        await begin();

                        let output: unknown;

                        try {
                            output = await execute.apply(definition, executeArgs);
                        } catch (error) {
                            end();

                            throw error;
                        }

                        // A streaming tool is open until its last yield.
                        if (isAsyncIterable(output)) {
                            const stream = output;

                            return (async function* markedStream() {
                                try {
                                    yield* stream;
                                } finally {
                                    end();
                                }
                            })();
                        }

                        end();

                        return output;
                    },
                };
            }

            return marked as T;
        },
    };
};
