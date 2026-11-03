/**
 * What `chat/lib/auto-model.ts` needs to know about a thread before it asks the gateway to route a send: how big
 * the conversation is and which kinds of attachment the run will send. Both are read from the history that ends at
 * the run's own prompt (the rows model assembly sends), not from the thread's leaf, which on a regenerate is an
 * earlier reply the new one replaces.
 */
import { PROMPT_CACHE_COLD_START_TOKENS } from "@neore/ai/models";
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalQuery, type QueryCtx } from "../_generated/server";
import { pathExceedsColdStart } from "../agent/agent-switch";
import { getThreadRow, walkPath } from "../agent/branch-rows";
import { attachmentsIn } from "./lib/backup-model";

/** Rows of the path read: the window a run sends (`DEFAULT_RECENT_MESSAGES`). */
const PATH_ROWS = 100;

/** Chat files looked up per read. Every file of the window is classified, a batch at a time. */
const FILE_BATCH = 50;

export interface AutoRouteContext {
    contextTokens: number;
    files: boolean;
    images: boolean;
}

/**
 * Throws when a file of the window cannot be classified: an attachment nobody checked must not read as absent, and the
 * caller keeps its fallback model instead.
 */
export const autoRouteContextOf = async (
    ctx: QueryCtx,
    args: { promptMessageId: string; stateless?: boolean; threadId: Id<"threads"> },
): Promise<AutoRouteContext> => {
    const prompt = await getThreadRow(ctx, args.threadId, args.promptMessageId);

    if (!prompt) {
        throw new Error("The prompt of the run is not in the thread");
    }

    // A stateless run sends the prompt alone; a stateful one sends only the successful rows of the window.
    const walked = args.stateless ? null : await walkPath(ctx, args.threadId, prompt, { limit: PATH_ROWS });
    const window = walked ? walked.rows.filter((row) => row.status === "success") : [prompt];
    const found = attachmentsIn(window.map((row) => row.message));
    const fileIds = [...new Set(window.flatMap((row) => row.fileIds ?? []))];

    for (let start = 0; start < fileIds.length; start += FILE_BATCH) {
        const batch = fileIds.slice(start, start + FILE_BATCH) as Id<"chatFiles">[];
        const { page } = await ctx.db.chatFiles.findMany({ where: { _id: { in: batch } } });

        if (page.length < batch.length) {
            throw new Error("An attached file could not be classified");
        }

        for (const file of page) {
            if (file.mediaType.startsWith("image/")) {
                found.images = true;
            } else {
                found.files = true;
            }
        }
    }

    const long = !args.stateless && (await pathExceedsColdStart(ctx, args.threadId, prompt, { maxRows: PATH_ROWS }));

    return { contextTokens: long ? PROMPT_CACHE_COLD_START_TOKENS + 1 : 0, ...found };
};

export const getAutoRouteContext = internalQuery
    .input({ promptMessageId: v.string().max(64), stateless: v.optional(v.boolean()), threadId: v.id("threads") })
    .output(v.object({ contextTokens: v.number(), files: v.boolean(), images: v.boolean() }))
    .query(async ({ args, ctx }) => await autoRouteContextOf(ctx, args));
