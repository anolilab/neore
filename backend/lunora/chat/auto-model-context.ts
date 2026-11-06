/**
 * What `chat/lib/auto-model.ts` needs to know about a thread before it asks the gateway to route a send: how big the
 * history the reply reads is, and which kinds of attachment it carries. Both come from the rows model assembly reads
 * (the newest successful window, orphaned tool results left out), anchored on the run's own prompt, not the thread's leaf.
 */
import { estimateTokensFromCharacters } from "@neore/ai/models";
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalQuery, type QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { getThreadRow } from "../agent/branch-rows";
import { estimateContext } from "../agent/thread-compaction";
import { ownedBy, summariesOf } from "../agent/thread-summaries";
import { replyWindowRows, rowCharacters } from "../agent/handoff-source";
import { attachmentsIn } from "./lib/backup-model";

type Row = Doc<"messages">;

/** Rows of the window a reply reads (`DEFAULT_RECENT_MESSAGES`). */
const PATH_ROWS = 100;

/** Chat files looked up per read. Every file of the window is classified, a batch at a time. */
const FILE_BATCH = 50;

/** A property of a stored value, or `undefined` when the value has no such property. */
const field = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined);

/** The parts of a row's message, or none when it holds no list of parts. */
const partsOf = (row: Row): unknown[] => {
    const content = field(row.message, "content");

    return Array.isArray(content) ? content : [];
};

/**
 * The rows model assembly keeps: a tool result whose call is not in the window is dropped, as the reader drops it, so
 * a file on it cannot decide the route for a result the model never sees.
 */
const keptRows = (rows: Row[]): Row[] => {
    const callIds = new Set<unknown>();

    for (const row of rows) {
        for (const part of partsOf(row)) {
            if (field(part, "type") === "tool-call") {
                callIds.add(field(part, "toolCallId"));
            }
        }
    }

    return rows.filter((row) => {
        if (field(row.message, "role") !== "tool") {
            return true;
        }

        return partsOf(row).some((part) => field(part, "type") === "tool-result" && callIds.has(field(part, "toolCallId")));
    });
};

export interface AutoRouteContext {
    /** The size of the history the reply reads, in tokens (`0` for an empty one). */
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

    // A stateless run sends the prompt alone; a stateful one sends the successful window, as model assembly reads it.
    const window = args.stateless ? [prompt] : await replyWindowRows(ctx, args.threadId, prompt, PATH_ROWS);
    const docs = keptRows(window);

    // A compaction stands on this path: the request is its notes plus the rows after it. Sizing and attachments read only
    // the rows the request sends, so a file reference in a row it covers cannot fail the routing.
    const thread = ownedBy(await ctx.db.get("threads", args.threadId));
    const summaries = thread ? await summariesOf(ctx, thread._id) : [];
    const hasCompaction = summaries.some((row) => row.kind === "compact");
    // The estimate walks the path, so it runs only when a compaction row stands: most threads have none. A stateless reply
    // sends the prompt alone, so the retained history and its summary do not size it.
    const compacted = thread && hasCompaction && !args.stateless ? await estimateContext(ctx, thread, prompt) : undefined;
    const covered = compacted?.compactedAt === undefined ? undefined : compacted.covered;
    const sent =
        covered === undefined ? docs : docs.filter((row) => row.order > covered.order || (row.order === covered.order && row.stepOrder > covered.stepOrder));
    const found = attachmentsIn(sent.map((row) => row.message));
    const fileIds = [...new Set(sent.flatMap((row) => row.fileIds ?? []))];

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

    if (covered === undefined || compacted === undefined) {
        // `rowCharacters` counts what a tool result returned, so an understated history cannot route a reply to a smaller model.
        const characters = docs.reduce((sum, row) => sum + rowCharacters(row), 0);

        return { contextTokens: Math.ceil(estimateTokensFromCharacters(characters)), ...found };
    }

    return { contextTokens: compacted.tokens, ...found };
};

export const getAutoRouteContext = internalQuery
    .input({ promptMessageId: v.string().max(64), stateless: v.optional(v.boolean()), threadId: v.id("threads") })
    .output(v.object({ contextTokens: v.number(), files: v.boolean(), images: v.boolean() }))
    .query(async ({ args, ctx }) => await autoRouteContextOf(ctx, args));
