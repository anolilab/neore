import type { PaginationResult } from "lunorash/server";
import { signDocsForDisplay } from "../agent/display-media";
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";

/**
 * Composite Query Endpoints
 *
 * These queries consolidate multiple data fetches into single queries to reduce
 * the "thundering herd" problem where many parallel queries cause database contention
 * and timeouts. Each composite query performs one authentication check and then
 * fetches all related data in parallel using direct DB operations — zero runQuery overhead.
 */
// Types come from the modules that DECLARE them, not from the `agent/client`
// barrel. This began as a workaround — codegen appended `.js` to the directory
// module and emitted an unresolvable `../agent/client.js`. That is fixed; it now
// writes `../agent/client/index.js`.
//
// It is kept because it is the better shape regardless. Codegen records the
// module a type was resolved THROUGH, so importing via a barrel makes generated
// output depend on that re-export continuing to exist. Pointing at the
// declaration site removes the coupling. Values still come from the barrel;
// only type resolution matters here.
import type { ThreadDoc } from "../agent/validators";
import type { UIMessage } from "../agent/ui-messages";
import { listMessagesByThreadIdHandler, toUIMessages } from "../agent/client";
import { type StepUsage, sumStepUsage } from "../agent/message-cost";
import { type RedactedThread, redactThreadForPublicViewer, resolveThreadReadAccess, type ThreadPermission } from "../agent/thread-read-access";
import { getThreadListDataBatchHandler, publicThread } from "../agent/threads";
import { liteAuthQuery } from "../lib/crpc";
import { loadNsfwStatuses, type RedactedUIMessage, redactUIMessagesForPublicViewer } from "./lib/public-thread";
import type { ThreadTagColor } from "./tags/logic";
import { MAX_THREAD_TAGS_PER_USER } from "./tags/logic";
import { MAX_LENGTH } from "../lib/validators";

// Type definitions for composite query results
interface ThreadUsage {
    cachedInputTokens?: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    totalTokens: number;
}

interface FollowupSuggestions {
    lastMessageId?: string;
    suggestions: string[];
}

/**
 * The owner/grantee view, or a public thread's redacted one: an allow-listed
 * thread with no `userId` (what the web app reads as "send this viewer to
 * /thread/$token") and allow-listed messages. Both redacted shapes are
 * structural subsets of the full ones.
 */
type ThreadWithDataResult =
    | {
          messages: PaginationResult<UIMessage>;
          permission: ThreadPermission;
          suggestions: FollowupSuggestions;
          thread: ThreadDoc;
          usage: ThreadUsage;
      }
    | {
          messages: PaginationResult<RedactedUIMessage>;
          permission: "read";
          suggestions: FollowupSuggestions;
          thread: RedactedThread<ThreadDoc>;
          usage: ThreadUsage;
      };

/**
 * Composite query that returns thread + messages + usage + suggestions in one call.
 * All DB operations are inlined — zero runQuery validator round-trips.
 * Uses lightweight auth (JWT-only, zero DB reads for auth) for 60-80% faster auth.
 *
 * Previously did 4 runQuery calls (each internally doing another runQuery) = 7 validator
 * round-trips. Now performs all DB reads directly in a single transaction.
 */
export const getThreadWithData = liteAuthQuery
    .input({
        messageOpts: v.optional(v.object({ cursor: v.union(v.string().max(MAX_LENGTH.cursor), v.null()), numItems: v.number() })),
        threadId: v.id("threads"),
    })
    .query(async ({ args: { messageOpts, threadId }, ctx: context }): Promise<ThreadWithDataResult> => {
        const { userId } = context.user;

        // Owner or live grantee: everything. A public thread read without a grant
        // is the redacted view — the same allow-list as the share page.
        const access = await resolveThreadReadAccess(context, threadId, userId);

        if (!access) {
            throw new LunoraError("FORBIDDEN", "Access denied to this thread");
        }

        const { thread } = access;

        // All data fetches in parallel — zero runQuery overhead
        const [rawMessages, usageMessages, cachedSuggestions] = await Promise.all([
            listMessagesByThreadIdHandler(context, {
                order: "desc" as const,
                paginationOpts: {
                    cursor: messageOpts?.cursor ?? null,
                    numItems: Math.max(1, Math.min(messageOpts?.numItems ?? 10, 10)),
                },
                statuses: ["success", "pending", "failed"],
                threadId: threadId as Id<"threads">,
            }),
            // Usage of up to the 1000 most recent rows that carry any (the walk
            // of `threadId_status_tool_order_stepOrder`, descending). Only
            // `usage` is read: a message row's content is most of its bytes.
            // The ORM facade rather than the legacy builder, which under
            // row-level security used to drop the SQL LIMIT and read the whole
            // thread (anolilab/lunora#822, fixed in `@lunora/server@alpha.145`).
            context.db.messages.findMany({
                limit: 1000,
                orderBy: [{ status: "desc" }, { tool: "desc" }, { order: "desc" }, { stepOrder: "desc" }, { _creationTime: "desc" }],
                select: ["usage"],
                where: { threadId: threadId as Id<"threads">, usage: { isNull: false } },
            }),
            // Inline getCachedFollowupSuggestions: direct lookup
            context.db.followupSuggestions.findFirst({ orderBy: [{ _creationTime: "asc" }], where: { threadId } }),
        ]);

        const messages: PaginationResult<UIMessage> = {
            ...rawMessages,
            // `Doc<"messages">[]` vs the parameter's wire shape: `toUIMessages`
            // is typed against rows whose branded ids have been widened to
            // `string` by an output validator, and these come straight from the
            // DB. Same mismatch as the GDPR export projections — not a real
            // incompatibility, but the two shapes are structurally distinct.
            page: toUIMessages((await signDocsForDisplay(context, rawMessages.page as never)) as never),
        };

        const summed = sumStepUsage(usageMessages.page.map((message) => message.usage as StepUsage | undefined));
        const usage: ThreadUsage = {
            cachedInputTokens: summed?.cachedInputTokens ?? 0,
            inputTokens: summed?.promptTokens ?? 0,
            outputTokens: summed?.completionTokens ?? 0,
            reasoningTokens: summed?.reasoningTokens ?? 0,
            totalTokens: summed?.totalTokens ?? 0,
        };

        const suggestions: FollowupSuggestions = cachedSuggestions
            ? { lastMessageId: cachedSuggestions.lastMessageId, suggestions: cachedSuggestions.suggestions }
            : { suggestions: [] };

        // publicThread = omit(thread, ["parentThreadIds"]) + projectId cast
        const threadDocument = publicThread(thread);

        if (access.kind === "redacted") {
            // No usage or suggestions: token counts and follow-ups are the owner's.
            return {
                messages: { ...messages, page: redactUIMessagesForPublicViewer(messages.page, await loadNsfwStatuses(context, messages.page)) },
                permission: "read",
                suggestions: { suggestions: [] },
                thread: redactThreadForPublicViewer(threadDocument),
                usage: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
            };
        }

        return {
            messages,
            permission: access.permission,
            suggestions,
            thread: threadDocument,
            usage,
        };
    });

// Type definitions for thread list composite result
interface ThreadListDataResult {
    pinnedThreads: ThreadDoc[];
    relationships: {
        branchPoint?: number;
        branchType?: "branch" | "continuation";
        createdAt: number;
        parentThreadId: string;
        threadId: string;
    }[];
    // User-defined tags, in display order. Carried here rather than by a query
    // of their own so the thread list's first paint stays one request.
    tags: { _id: string; color: ThreadTagColor; name: string; order: number }[];
    temporaryThreads: PaginationResult<ThreadDoc>;
    threadOrders: ThreadDoc[];
    threads: PaginationResult<ThreadDoc>;
}

/**
 * Composite query that returns all thread list data in one call.
 * Calls the exported handler directly — zero runQuery validator overhead.
 * Uses lightweight auth (JWT-only, zero DB reads for auth) for 60-80% faster auth.
 */
export const getThreadListData = liteAuthQuery
    .input({
        paginationOpts: v.optional(v.object({ cursor: v.union(v.string().max(MAX_LENGTH.cursor), v.null()), numItems: v.number() })),
    })
    .query(async ({ args: { paginationOpts }, ctx: context }): Promise<ThreadListDataResult> => {
        const { userId } = context.user;

        // Direct handler call — bypasses runQuery validator overhead
        const [listData, tags] = await Promise.all([
            getThreadListDataBatchHandler(context, {
                excludeTemporary: true,
                paginationOpts: paginationOpts ?? { cursor: null, numItems: 100 },
                userId,
            }),
            // ORM facade, not the legacy builder: see `getThreadListDataBatchHandler`.
            context.db.threadTags.findMany({
                limit: MAX_THREAD_TAGS_PER_USER,
                orderBy: [{ order: "asc" }, { _creationTime: "asc" }],
                where: { userId },
            }),
        ]);

        return {
            ...listData,
            tags: tags.page.map((tag) => {
                return { _id: tag._id as string, color: tag.color, name: tag.name, order: tag.order };
            }),
        } as unknown as ThreadListDataResult;
    });
