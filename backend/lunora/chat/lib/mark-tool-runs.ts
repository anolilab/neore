/**
 * Marks every tool call of a run on its stream while it executes (`markToolRun`), so a worker that dies inside a tool
 * is never resumed: the tool may have paid for or changed something and leaves no row (`interrupted-run.ts`).
 * The mark is written BEFORE the tool starts and a refused mark (the stream ended) stops the tool; the unmark is
 * best effort, because a lost one only makes a later death fail instead of resume.
 */
import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
    typeof value === "object" && value !== null && Symbol.asyncIterator in (value as object);

export const markToolRuns = <T extends Record<string, unknown>>(ctx: Pick<ActionCtx, "runMutation">, streamId: string, tools: T): T => {
    const mark = async (delta: 1 | -1) =>
        await ctx.runMutation(internal.chat.streaming.persistent.interrupted.markToolRun, { delta, streamId: streamId as Id<"persistentStreams"> });
    const end = async () => {
        await mark(-1).catch(() => undefined);
    };

    const marked: Record<string, unknown> = {};

    for (const [name, definition] of Object.entries(tools)) {
        const execute = (definition as { execute?: (...args: unknown[]) => unknown } | undefined)?.execute;

        if (typeof execute !== "function") {
            marked[name] = definition;

            continue;
        }

        marked[name] = {
            ...(definition as object),
            execute: async (...args: unknown[]) => {
                await mark(1);

                let output: unknown;

                try {
                    output = await execute.apply(definition, args);
                } catch (error) {
                    await end();

                    throw error;
                }

                // A streaming tool is open until its last yield.
                if (isAsyncIterable(output)) {
                    const stream = output;

                    return (async function* markedStream() {
                        try {
                            yield* stream;
                        } finally {
                            await end();
                        }
                    })();
                }

                await end();

                return output;
            },
        };
    }

    return marked as T;
};
