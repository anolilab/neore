/**
 * Marks every tool call of a run on its stream while it executes (`markToolRun`), so a worker that dies inside a tool
 * is never resumed: the tool may have paid for or changed something and leaves no row (`interrupted-run.ts`).
 *
 * The mark is written BEFORE the tool starts and stays until the step that holds the call has been SAVED (`release`,
 * from the step's `onStepFinish`, which the agent runs after it saved the rows). A tool that has returned but whose
 * rows are not saved yet is still unaccounted for: a death in that window would otherwise look like "not in a tool" and
 * the resume would call the tool again. A mark that fails for any reason (the stream ended,
 * a newer run holds it, a shard error) stops the tool: it never runs without a confirmed mark. The one exception is a shard
 * error on a run that cannot be resumed (stateless, opted out, not registered): a death then ends the run for good, so
 * there is no second run for a tool to be repeated by, and the tool runs with the error logged.
 *
 * A tool that is safe to repeat (`repeatable-tools.ts`) is checked before it starts (`repeatable`: the stream must be
 * live and held by this run) but is not counted: a death inside it leaves nothing open, so the run is resumed from its
 * last saved row and the model calls the tool again. A shard error on that check only logs: a read has nothing a
 * resume could double, and a run that was replaced meanwhile still has every write fenced.
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
    /** `repeatable`: the names of the tools that are safe to repeat; every other tool is counted. */
    wrap: <T extends Record<string, unknown>>(tools: T, repeatable?: ReadonlySet<string>) => T;
}

export const createToolRunMarker = (
    ctx: Pick<ActionCtx, "runMutation">,
    args: {
        epoch: number;
        /** Whether a death of this run would be answered by a resume. Only then does a failed mark stop a tool. */
        isResumable: () => boolean;
        onReplaced: () => void;
        streamId: string;
    },
): ToolRunMarker => {
    const { epoch, isResumable, onReplaced, streamId } = args;
    // Tools marked and not yet released, and of those the ones that returned (or threw) and wait for their step to be saved.
    let open = 0;
    let finished = 0;
    // A mark whose answer was lost may or may not have landed: the next release states the count outright to settle it.
    let uncertain = false;
    const mark = async (delta: number, setTo?: number, repeatable?: true) =>
        await ctx.runMutation(internal.chat.streaming.persistent.interrupted.markToolRun, {
            delta,
            epoch,
            ...(repeatable && { repeatable }),
            ...(setTo !== undefined && { setTo }),
            streamId: streamId as Id<"persistentStreams">,
        });
    // Any failure of the mark stops the tool: one that ran without a confirmed mark could be run again by a resume after a death.
    const begin = async (repeatable: boolean) => {
        try {
            if (repeatable) {
                await mark(1, undefined, true);

                return;
            }

            await mark(1);
            open += 1;
        } catch (error) {
            if (isRunReplaced(error)) {
                onReplaced();

                throw error;
            }

            // A stream that is no longer live stops the tool whatever else is true.
            if (errorCodeOf(error) === "CONFLICT") {
                throw error;
            }

            // A hiccup on the shard: with a resume possible the tool must not run unmarked (a resume could run it twice); a run
            // that cannot be resumed, or a tool that is safe to repeat, has nothing to protect, so the tool runs and the hiccup is only logged.
            if (!repeatable && isResumable()) {
                uncertain = true;

                throw error;
            }

            streamLogger.warn(
                `[BgAgent] Could not mark a tool call on stream ${streamId}; nothing a resume could repeat is at stake, so the tool runs:`,
                error,
            );
        }
    };
    const end = (repeatable: boolean) => {
        if (!repeatable) {
            finished += 1;
        }
    };

    return {
        release: async () => {
            if (finished === 0 && !uncertain) {
                return;
            }

            // The count the stream should hold now: the tools still running. Stated as an absolute value, so sending it
            // again after an answer was lost cannot undercount a live tool; a failure leaves everything as it was and the
            // next step's release tries again.
            const remaining = open - finished;

            try {
                await mark(0, remaining);
                open = remaining;
                finished = 0;
                uncertain = false;
            } catch (error) {
                if (isRunReplaced(error)) {
                    onReplaced();
                }
            }
        },
        wrap: <T extends Record<string, unknown>>(tools: T, repeatable: ReadonlySet<string> = new Set()): T => {
            const marked: Record<string, unknown> = {};

            for (const [name, definition] of Object.entries(tools)) {
                const execute = (definition as { execute?: (...args: unknown[]) => unknown } | undefined)?.execute;

                if (typeof execute !== "function") {
                    marked[name] = definition;

                    continue;
                }

                const safe = repeatable.has(name);

                marked[name] = {
                    ...(definition as object),
                    // `this`, not the definition: a tool made by `createTool` reads its `ctx` off `this`, and `wrapTools` attaches
                    // that `ctx` to a COPY of whatever object it is given, which is this wrapper.
                    execute: async function markedExecute(this: unknown, ...executeArgs: unknown[]) {
                        await begin(safe);

                        let output: unknown;

                        try {
                            output = await execute.apply(this, executeArgs);
                        } catch (error) {
                            end(safe);

                            throw error;
                        }

                        // A streaming tool is open until its last yield.
                        if (isAsyncIterable(output)) {
                            const stream = output;

                            return (async function* markedStream() {
                                try {
                                    yield* stream;
                                } finally {
                                    end(safe);
                                }
                            })();
                        }

                        end(safe);

                        return output;
                    },
                };
            }

            return marked as T;
        },
    };
};
