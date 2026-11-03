/**
 * What `chat/lib/auto-model.ts` needs to know about a thread before it asks the gateway to route a send: how big
 * the conversation is and which kinds of attachment the run will send (the path's recent rows, the latest prompt
 * included, since it is saved before the run starts).
 */
import { PROMPT_CACHE_COLD_START_TOKENS } from "@neore/ai/models";
import { v } from "lunorash/server";

import { internalQuery } from "../_generated/server";
import { leafRowOf, pathExceedsColdStart } from "../agent/agent-switch";
import { walkPath } from "../agent/branch-rows";
import { attachmentsIn } from "./lib/backup-model";

/** Rows of the path read for attachments: the window a run sends (`DEFAULT_RECENT_MESSAGES`). */
const PATH_ROWS = 100;

/** Chat files looked up for their media type. */
const MAX_FILE_LOOKUPS = 50;

export const getAutoRouteContext = internalQuery
    .input({ threadId: v.id("threads") })
    .output(v.object({ contextTokens: v.number(), files: v.boolean(), images: v.boolean() }))
    .query(async ({ args, ctx }) => {
        const thread = await ctx.db.get("threads", args.threadId);
        const leaf = thread ? await leafRowOf(ctx, thread) : null;

        if (!thread || !leaf) {
            return { contextTokens: 0, files: false, images: false };
        }

        const { rows } = await walkPath(ctx, thread._id, leaf, { limit: PATH_ROWS });
        const found = attachmentsIn(rows.map((row) => row.message));
        const fileIds = [...new Set(rows.flatMap((row) => row.fileIds ?? []))].slice(0, MAX_FILE_LOOKUPS);
        const { page: stored } = fileIds.length > 0 ? await ctx.db.chatFiles.findMany({ where: { _id: { in: fileIds } } }) : { page: [] };

        for (const file of stored) {
            if (file.mediaType.startsWith("image/")) {
                found.images = true;
            } else {
                found.files = true;
            }
        }

        const long = await pathExceedsColdStart(ctx, thread._id, leaf);

        return { contextTokens: long ? PROMPT_CACHE_COLD_START_TOKENS + 1 : 0, ...found };
    });
