/**
 * User image inventory queries.
 *
 * Powers the multi-reference image picker and (later) the Library view. The
 * picker needs a paginated feed of every image a user owns, either scoped to
 * the current thread or across all of their threads.
 *
 * Two underlying sources:
 *   - `files` (vault) — user-uploaded images and AI-generated images saved to
 *     R2. Has clean `isGenerated` flag, `chatId` scoping, and `by_user` /
 *     `by_user_and_chatId` indexes.
 *   - `documents` of kind `"image"` — canvas artifacts where the image lives in
 *     `content` (base64 or R2 URL). Indexed `by_userId` and `by_threadId_and_kind`.
 *
 * Pagination is driven by the vault rows' `_creationTime` (the natural
 * index ordering). Documents are eager-loaded per request, bounded by a cap,
 * and merged in. In-memory sorting also uses `_creationTime` so the merged
 * order matches the cursor's natural order — that's what prevents the same
 * item from appearing on two consecutive pages.
 */
import type { Infer } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { authQuery } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";

const IMAGE_MIME_PREFIX = "image/";

/** Hard cap on items per page. Picker's grid never shows more than this. */
const MAX_PAGE_SIZE = 60;

/**
 * Upper bound on the document scan for `scope="all"`. The picker needs
 * "newest first", so we cap at a few page-fulls worth — anything older than
 * that bucket is virtually never selected from a picker anyway. The Library
 * view (Tier 3) will get its own paginated query when we ship it.
 */
const MAX_DOCUMENT_SCAN = MAX_PAGE_SIZE * 4;

/**
 * Pull the MIME type out of a data URL or fall back to PNG.
 *
 * Data URLs come in two shapes:
 *   - `data:<mime>;base64,<payload>`   (most common — semicolon then base64 flag)
 *   - `data:<mime>,<payload>`          (rare — direct payload, no flags)
 *
 * Exposed for unit tests; the loop body calls it directly.
 */
export const parseDataUrlMime = (content: string): string => {
    const FALLBACK = "image/png";

    if (!content.startsWith("data:")) return FALLBACK;

    const semi = content.indexOf(";");
    const comma = content.indexOf(",");

    // Pick whichever delimiter comes first (and exists). slice(5, end) extracts
    // everything between "data:" and the delimiter.
    let end: number;

    if (semi !== -1 && (comma === -1 || semi < comma)) {
        end = semi;
    } else if (comma === -1) {
        return FALLBACK;
    } else {
        end = comma;
    }

    if (end <= 5) return FALLBACK;

    const mime = content.slice(5, end);

    return mime || FALLBACK;
};

export const sourceSchema = v.union(v.literal("uploaded"), v.literal("generated"), v.literal("document"));

export const imageItemSchema = v.object({
    /** Unix ms. Used for ordering and "x ago" rendering. */
    createdAt: v.number(),
    /** Stable id for React keys. Prefixed with table so picker can collapse duplicates. */
    id: v.string(),
    mimeType: v.string(),
    source: sourceSchema,
    threadId: v.union(v.string(), v.null()),
    threadTitle: v.union(v.string(), v.null()),
    thumbnailUrl: v.union(v.string(), v.null()),
    url: v.string(),
});

export const paginationOptionsSchema = v.object({
    cursor: v.union(v.string(), v.null()),
    // `z.int().min(1).max(MAX_PAGE_SIZE)` as a native check — on a paginated query
    // the bound is the difference between a page and a table scan.
    numItems: v.number().check((n) => Number.isSafeInteger(n) && n >= 1 && n <= MAX_PAGE_SIZE, {
        message: `numItems must be an integer between 1 and ${MAX_PAGE_SIZE}`,
        schema: { maximum: MAX_PAGE_SIZE, minimum: 1, type: "integer" },
    }),
});

export const scopeSchema = v.union(v.literal("thread"), v.literal("all"));

export const MEDIA_MAX_PAGE_SIZE = MAX_PAGE_SIZE;

/**
 * List images owned by the current user.
 *
 * `scope="thread"` requires `threadId` and is gated on ownership of that thread.
 * `scope="all"` fans out across every thread, paginated by vault `createdAt`
 * via the `by_user` index.
 *
 * Documents of `kind: "image"` are eager-loaded per request (typically a
 * handful per user) and merged into the page, then truncated back to
 * `numItems`. The cursor only paginates the vault rows — documents above the
 * vault page's `createdAt` floor are always re-emitted on the first page.
 * This is intentional for the picker: the user wants their most recent images
 * front and centre; document images are rare enough that re-emission is fine.
 */
export const listUserImages = authQuery
    // Native validators. The zod versions stay exported — `functions.test.ts`
    // exercises them directly, and they document the contract — but codegen cannot
    // read through `v.from(…)`, so `scope` and `paginationOpts` arrived as
    // `unknown`. `numItems` also had a `.min(1).max(MAX_PAGE_SIZE)` that never ran,
    // which on a paginated query is the difference between a page and a table scan.
    .input({
        paginationOpts: v.object({ cursor: v.union(v.string().max(MAX_LENGTH.cursor), v.null()), numItems: v.number() }),
        scope: v.union(v.literal("thread"), v.literal("all")),
        threadId: v.optional(v.id("threads")),
    })
    .output(
        v.from(
            v.object({
                continueCursor: v.union(v.string(), v.null()),
                isDone: v.boolean(),
                items: v.array(imageItemSchema),
            }),
        ),
    )
    .query(async ({ args: input, ctx: context }) => {
        const { userId } = context.user;
        const { scope, threadId } = input;

        if (scope === "thread" && !threadId) {
            throw new LunoraError("BAD_REQUEST", "threadId is required when scope='thread'");
        }

        // Ownership gate for scope='thread'. The vault `by_user_and_chatId`
        // index already filters to the user's own files, but a user could
        // pass any threadId in `scope='thread'` and we'd happily query an
        // empty result. Verifying ownership keeps the contract honest and
        // gives the picker a clear NOT_FOUND signal for typos.
        if (scope === "thread" && threadId) {
            const thread = await context.db.get(threadId as Id<"threads">);

            if (!thread || (thread as { userId?: string }).userId !== userId) {
                throw new LunoraError("NOT_FOUND", "Thread not found");
            }
        }

        // The bound the zod schema declared and never enforced.
        const paginationOptions = { cursor: input.paginationOpts.cursor, numItems: Math.min(MAX_PAGE_SIZE, Math.max(1, input.paginationOpts.numItems)) };

        // Vault page — primary source.
        const vaultQuery =
            scope === "thread"
                ? context.db.query("files").withIndex("by_user_and_chatId", (q) => q.eq("userId", userId).eq("chatId", threadId!))
                : context.db.query("files").withIndex("by_user_and_folder", (q) => q.eq("userId", userId));

        // We over-fetch a bit and filter to image MIME, since vault stores
        // every file type and a `type` index doesn't exist. The grid cap is
        // 60, so even at a 10% image ratio we'd still fill the page in two
        // pagination hops in the worst case.
        const vaultPage = await vaultQuery.order("desc").paginate(paginationOptions);

        const vaultImages = vaultPage.page.filter((row) => {
            const { type } = row as { type?: string };

            return typeof type === "string" && type.startsWith(IMAGE_MIME_PREFIX);
        });

        // Document images — secondary source.
        //
        // `scope="thread"` uses the (threadId, kind) compound index so the
        // server pre-filters to image documents; bounded by definition.
        //
        // `scope="all"` has no (userId, kind) index, so we walk the user's
        // documents newest-first and stop at MAX_DOCUMENT_SCAN. Documents
        // older than that won't appear in the picker — acceptable until the
        // Library view (Tier 3 #9) ships with its own paginated query.
        const documents =
            scope === "thread"
                ? await context.db
                      .query("documents")
                      .withIndex("by_threadId_and_kind", (q) => q.eq("threadId", threadId! as Id<"threads">).eq("kind", "image"))
                      .collect()
                : await context.db
                      .query("documents")
                      .withIndex("by_userId", (q) => q.eq("userId", userId))
                      .order("desc")
                      .filter((document) => document.kind === "image")
                      .take(MAX_DOCUMENT_SCAN);

        // Resolve thread titles in a single batch. Both sources may reference
        // many threads, but typically a handful in practice.
        const threadIds = new Set<string>();

        for (const row of vaultImages) {
            const { chatId } = row as { chatId?: string };

            if (chatId) threadIds.add(chatId);
        }

        for (const document of documents) {
            const tid = (document as { threadId?: string }).threadId;

            if (tid) threadIds.add(tid);
        }

        const threadTitleById = new Map<string, string | null>();

        await Promise.all(
            [...threadIds].map(async (tid) => {
                const thread = await context.db.get(tid as Id<"threads">);

                threadTitleById.set(tid, (thread as { title?: string } | null)?.title ?? null);
            }),
        );

        // Materialise unified shape. `createdAt` on the returned items
        // always carries `_creationTime` so the in-memory sort matches the
        // cursor's natural order — that's what prevents the same row from
        // showing up on consecutive pages.
        type VaultRow = {
            _creationTime: number;
            _id: Id<"files">;
            chatId?: string;
            isGenerated?: boolean;
            type?: string;
            url?: string;
        };

        type DocumentRow = {
            _creationTime: number;
            _id: Id<"documents">;
            content?: string;
            threadId: Id<"threads">;
        };

        const items: Infer<typeof imageItemSchema>[] = [];

        for (const row of vaultImages as unknown as VaultRow[]) {
            if (!row.url) continue; // Defensive: skip files without a public URL.

            items.push({
                createdAt: row._creationTime,
                id: `file:${row._id}`,
                mimeType: row.type ?? "image/*",
                source: row.isGenerated ? "generated" : "uploaded",
                threadId: row.chatId ?? null,
                threadTitle: row.chatId ? (threadTitleById.get(row.chatId) ?? null) : null,
                thumbnailUrl: row.url,
                url: row.url,
            });
        }

        for (const document of documents as unknown as DocumentRow[]) {
            if (!document.content) continue; // Image documents store URL/data URL in content.

            items.push({
                createdAt: document._creationTime,
                id: `doc:${document._id}`,
                mimeType: parseDataUrlMime(document.content),
                source: "document",
                threadId: document.threadId,
                threadTitle: threadTitleById.get(document.threadId) ?? null,
                thumbnailUrl: document.content,
                url: document.content,
            });
        }

        // Newest first by `_creationTime`. Matches the vault cursor's order.
        items.sort((a, b) => b.createdAt - a.createdAt);

        // Truncate back to the requested page size so a giant document set
        // can't blow past `numItems` on a thin vault page.
        const truncated = items.slice(0, paginationOptions.numItems);

        return {
            continueCursor: vaultPage.continueCursor,
            isDone: vaultPage.isDone,
            items: truncated,
        };
    });
