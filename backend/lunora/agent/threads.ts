import type { InferArgs } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx as MutationContext, type QueryCtx as QueryContext } from "../_generated/server";
import { query } from "../lib/crpc";
import { getAuthUserIdentity } from "../auth";
import { deleteToolApprovalRunsForThread } from "../chat/lib/tool-approval-cleanup";

/**
 * Thread operations.
 * Migrated from `@neore/backend-agent` component.
 */
import { omit, pick } from "../lib/collections";
import { assert } from "../lib/error-helpers";
import { patchById, patchRow, withoutUndefined } from "../lib/patch";
import { paginationOptionsValidator, partial, MAX_LENGTH } from "../lib/validators";
import { deleteMessage } from "./messages";
import { deleteStreamsPageForThreadId } from "./streams";
import { meetsThreadPermission, redactThreadForPublicViewer, resolveThreadReadAccess, type ThreadPermission, admitOwnedThread } from "./thread-read-access";
import { type ThreadDoc, vPaginationResult, vThreadCreateFields, vThreadDoc as vThreadDocument, vThreadDocFields, vThreadStatus } from "./validators";
import { systemDb } from "../lib/rls/scope";

export const publicThread = (thread: Doc<"threads">): ThreadDoc => {
    const result = omit(thread, ["parentThreadIds"]);

    // `vThreadDoc` types `projectId` as a plain string, and `Id<"projects">` is a
    // branded `string`, so the widening needs no cast — the branch stays only to
    // narrow away the `undefined` the optional column carries.
    if (result.projectId) {
        return {
            ...result,
            projectId: result.projectId satisfies string,
        } as unknown as ThreadDoc;
    }

    return result as unknown as ThreadDoc;
};

/** The full row, unchecked — shared by both procedures below, which differ only in who may see it. */
const getThreadRow = async (ctx: QueryContext, threadId: Id<"threads">) => await ctx.db.get(threadId);

/**
 * Server-side twin of `getThread`: the FULL row, no caller check.
 *
 * For code that has already authorized the thread or acts on its owner's behalf
 * — actions, scheduled jobs, HTTP routes, the agent loop. Those often run with
 * no user identity, where `getThread` answers `null` for a private thread and
 * the redacted shape for a public one.
 */
export const getThreadInternal = internalQuery
    .input({ threadId: v.id("threads") })
    .output(v.from(v.union(vThreadDocument, v.null())))
    .query(async ({ args, ctx }) => {
        const thread = await getThreadRow(ctx, args.threadId);

        return thread ? publicThread(thread) : null;
    });

export const getThread = query
    .input({ threadId: v.id("threads") })
    .output(v.from(v.union(vThreadDocument, v.null())))
    .query(async ({ args, ctx }) => {
        // Owner or live grantee: the full row. Anyone else: a public thread's
        // redacted shape (no owner id, system prompt, org/team ids), else nothing.
        const identity = await getAuthUserIdentity(ctx);
        const access = await resolveThreadReadAccess(ctx, args.threadId, identity?.userId);

        if (!access) {
            return null;
        }

        return access.kind === "full" ? publicThread(access.thread) : redactThreadForPublicViewer(publicThread(access.thread));
    });

const listThreadsByUserIdArgs = {
    excludeTemporary: v.optional(v.boolean()),
    order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
    organizationId: v.optional(v.union(v.string().max(MAX_LENGTH.id), v.null())), // null = personal space, undefined = all
    paginationOpts: v.optional(paginationOptionsValidator),
    status: v.optional(vThreadStatus),
    teamId: v.optional(v.string().max(MAX_LENGTH.id)), // Filter by team within organization
    userId: v.optional(v.string().max(MAX_LENGTH.id)),
};

/** Lists one user's threads. WHOSE is the caller's decision — see the two procedures below. */
const listThreadsForUserHandler = async (ctx: QueryContext, args: InferArgs<typeof listThreadsByUserIdArgs>, resolvedUserId: string) => {
    // Determine which index to use based on filters
    const isUseTeamFilter = args.teamId !== undefined;
    const isUseOrgFilter = args.organizationId !== undefined;

    const direction = args.order ?? "desc";
    const paginationOptions = args.paginationOpts ?? { cursor: null, numItems: 100 };

    // The ORM facade, not the legacy builder: under row-level security the
    // legacy `paginate` used to read the caller's whole index range and slice
    // it in memory (fixed in `@lunora/server@alpha.145`, anolilab/lunora#822). Each branch spells out the
    // index walk it replaces.
    const page = { cursor: paginationOptions.cursor, limit: paginationOptions.numItems };
    let threads;

    if (isUseTeamFilter) {
        // `by_user_and_team`
        threads = await ctx.db.threads.findMany({
            ...page,
            orderBy: [{ teamId: direction }, { _creationTime: direction }],
            where: { teamId: args.teamId, userId: resolvedUserId },
        });
    } else if (isUseOrgFilter) {
        // `by_user_and_organization`; `null` is the personal space, an unset column.
        threads = await ctx.db.threads.findMany({
            ...page,
            orderBy: [{ organizationId: direction }, { _creationTime: direction }],
            where: { organizationId: args.organizationId === null ? { isNull: true } : args.organizationId, userId: resolvedUserId },
        });
    } else {
        // `by_user_and_status`
        threads = await ctx.db.threads.findMany({
            ...page,
            orderBy: [{ status: direction }, { deleted: direction }, { _creationTime: direction }],
            where: { userId: resolvedUserId },
        });
    }

    // Filter by status if provided, filter out deleted and optionally temporary threads
    const filteredPage = threads.page
        .filter((t) => {
            if (t.deleted) {
                return false;
            }

            if (args.excludeTemporary && t.isTemporary) {
                return false;
            }

            if (args.status !== undefined) {
                return t.status === args.status;
            }

            return true;
        })
        .map((t) => publicThread(t as unknown as Doc<"threads">));

    return { continueCursor: threads.continueCursor, isDone: threads.isDone, page: filteredPage };
};

export const listThreadsByUserId = query
    .input(listThreadsByUserIdArgs)
    .output(v.from(vPaginationResult(vThreadDocument)))
    .query(async ({ args, ctx }) => {
        // Require authentication — callers may only list their own threads
        const identity = await getAuthUserIdentity(ctx);

        if (!identity) {
            return { continueCursor: "", isDone: true, page: [] };
        }

        // If a userId was provided, verify it matches the authenticated caller
        if (args.userId && args.userId !== identity.userId) {
            return { continueCursor: "", isDone: true, page: [] };
        }

        // Use the authenticated user's ID when none is provided
        return await listThreadsForUserHandler(ctx, args, args.userId ?? identity.userId);
    });

/**
 * Server-side twin of `listThreadsByUserId` for code that has already decided
 * whose threads to read and runs with no identity (the GDPR export workflow).
 * The public query answers such callers with an empty page.
 */
export const listThreadsByUserIdInternal = internalQuery
    .input({ ...listThreadsByUserIdArgs, userId: v.string() })
    .output(v.from(vPaginationResult(vThreadDocument)))
    .query(async ({ args, ctx }) => await listThreadsForUserHandler(ctx, args, args.userId));

export const createThread = internalMutation
    .input(vThreadCreateFields)
    .output(v.from(vThreadDocument))
    .mutation(async ({ args, ctx }) => {
        const insertedId = await ctx.db.insert("threads", {
            ...args,
            status: "active",
        });
        const threadId = insertedId as Id<"threads">;
        const thread = (await ctx.db.get(threadId))!;

        // Insert into aggregates if applicable
        return publicThread(thread);
    });

export const threadFieldsSupportingPatch = [
    "title" as const,
    "summary" as const,
    "status" as const,
    "userId" as const,
    "model" as const,
    "tags" as const,
    "category" as const,
    "pinnedAt" as const,
    "order" as const,
    "enabledFeatures" as const,
    "reasoningEffort" as const,
    "statelessMode" as const,
    "customSystemPrompt" as const,
    "dictationLanguage" as const,
    "language" as const,
    "mode" as const,
    "isPublic" as const,
    "publicAccessToken" as const,
    "createdBy" as const,
    "updatedAt" as const,
    "projectId" as const,
    "organizationId" as const,
    "teamId" as const,
    "multiChat" as const,
    "deleted" as const,
    "deletedAt" as const,
    "isTemporary" as const,
] as const;

export type ThreadFieldsSupportingPatch = (typeof threadFieldsSupportingPatch)[number];

export const updateThread = internalMutation
    .input({
        patch: v.object(partial(pick(vThreadDocFields, [...threadFieldsSupportingPatch]))),
        threadId: v.id("threads"),
    })
    .output(v.from(vThreadDocument))
    .mutation(async ({ args, ctx }) => {
        const oldThread = await ctx.db.get(args.threadId);

        assert(oldThread, `Thread ${args.threadId} not found`);
        await ctx.db.patch(args.threadId, withoutUndefined(args.patch));
        const newThread = (await ctx.db.get(args.threadId))!;

        // Update aggregates
        // Handle thread orders aggregate
        return publicThread(newThread);
    });

export const searchThreadTitles = query
    .input({
        limit: v.number(),
        query: v.string().max(MAX_LENGTH.long),
        userId: v.optional(v.union(v.string().max(MAX_LENGTH.id), v.null())),
    })
    .output(v.from(v.array(vThreadDocument)))
    .query(async ({ args, ctx }) => {
        const identity = await getAuthUserIdentity(ctx);

        if (!identity) {
            return [];
        }

        // Force scope to authenticated user; ignore caller-supplied userId
        const scopedUserId = identity.userId;
        const threads = await ctx.db
            .query("threads")
            .withSearchIndex("title", (q) => q.search("title", args.query).eq("userId", scopedUserId))
            .take(args.limit);

        return threads.map((item) => publicThread(item));
    });

export const archiveThread = internalMutation
    .input({ threadId: v.id("threads") })
    .output(v.from(vThreadDocument))
    .mutation(async ({ args, ctx }) => {
        const oldThread = await ctx.db.get(args.threadId);

        assert(oldThread, `Thread ${args.threadId} not found`);
        await ctx.db.patch(args.threadId, {
            status: "archived",
            updatedAt: ctx.now,
        });
        const newThread = (await ctx.db.get(args.threadId))!;

        // Update aggregate - status changed
        return publicThread(newThread);
    });

export const unarchiveThread = internalMutation
    .input({ threadId: v.id("threads") })
    .output(v.from(vThreadDocument))
    .mutation(async ({ args, ctx }) => {
        const oldThread = await ctx.db.get(args.threadId);

        assert(oldThread, `Thread ${args.threadId} not found`);
        await ctx.db.patch(args.threadId, {
            status: "active",
            updatedAt: ctx.now,
        });
        const newThread = (await ctx.db.get(args.threadId))!;

        return publicThread(newThread);
    });

export const deleteAllForThreadIdSync = internalAction
    .input({ limit: v.optional(v.number()), threadId: v.id("threads") })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        let cursor: string | undefined;

        while (true) {
            const result: DeleteThreadReturns = await ctx.runMutation(internal.agent.threads._deletePageForThreadId, {
                cursor,
                limit: args.limit,
                threadId: args.threadId,
            });

            if (result.isDone) {
                break;
            }

            cursor = result.cursor ?? undefined;
        }
        await ctx.runAction(internal.agent.streams.deleteAllStreamsForThreadIdSync, {
            threadId: args.threadId,
        });

        // Declared `.output(v.null())`; return it rather than falling off the
        // end, which yields `undefined` and does not match the contract.
        return null;
    });

const deleteThreadArgs = {
    cursor: v.optional(v.string()),
    deltaCursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    messagesDone: v.optional(v.boolean()),
    streamOrder: v.optional(v.number()),
    streamsDone: v.optional(v.boolean()),
    threadId: v.id("threads"),
};

type DeleteThreadArgs = InferArgs<typeof deleteThreadArgs>;
const deleteThreadReturns = {
    cursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
};

type DeleteThreadReturns = InferArgs<typeof deleteThreadReturns>;

export const _deletePageForThreadId = internalMutation
    .input(deleteThreadArgs)
    .output(v.from(v.object(deleteThreadReturns)))
    .mutation(async ({ args, ctx }) => await deletePageForThreadIdHandler(ctx, args));

export const deleteAllForThreadIdAsync = internalMutation
    .input(deleteThreadArgs)
    .output(v.object({ isDone: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        let messagesResult: { cursor: null | string | undefined; isDone: boolean } = {
            cursor: args.cursor,
            isDone: args.messagesDone ?? false,
        };

        if (!args.messagesDone) {
            messagesResult = await deletePageForThreadIdHandler(ctx, args);
        }

        let streamResult = {
            deltaCursor: args.deltaCursor,
            isDone: args.streamsDone ?? false,
            streamOrder: args.streamOrder,
        };

        if (!args.streamsDone) {
            streamResult = await deleteStreamsPageForThreadId(ctx, {
                deltaCursor: args.deltaCursor,
                streamOrder: args.streamOrder,
                threadId: args.threadId,
            });
        }

        const isDone = messagesResult.isDone && streamResult.isDone;

        if (!isDone) {
            await ctx.scheduler.runAfter(0, internal.agent.threads.deleteAllForThreadIdAsync, {
                cursor: messagesResult.cursor,
                deltaCursor: streamResult.deltaCursor,
                messagesDone: messagesResult.isDone,
                streamOrder: streamResult.streamOrder,
                streamsDone: streamResult.isDone,
                threadId: args.threadId,
            });
        }

        return { isDone };
    });

async function deletePageForThreadIdHandler(context: MutationContext, args: DeleteThreadArgs): Promise<DeleteThreadReturns> {
    const messages = await context.db
        .query("messages")
        .withIndex("threadId_status_tool_order_stepOrder", (q) => q.eq("threadId", args.threadId))
        .paginate({
            cursor: args.cursor ?? null,
            numItems: args.limit ?? 100,
        });

    await Promise.all((messages.page as unknown as Doc<"messages">[]).map((m) => deleteMessage(context, m)));

    if (messages.isDone) {
        // Approval snapshots hold the run's system prompt; they go with the thread.
        await deleteToolApprovalRunsForThread(context, args.threadId);

        const thread = await context.db.get(args.threadId);

        if (thread) {
            // Remove from aggregates before deleting
            await context.db.delete(args.threadId);
        }

        // The temporary-chat marker goes with the thread on EVERY delete path.
        // Only the expiry cron removed it, so a temporary chat deleted any other
        // way left a marker the cron then kept finding for a thread that no
        // longer existed.
        const markers = await context.db
            .query("temporaryThreads")
            .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
            .collect();

        await Promise.all(markers.map((marker) => context.db.delete(marker._id)));
    }

    return {
        cursor: messages.continueCursor,
        isDone: messages.isDone,
    };
}

// Thread pinning functions
export const pinThread = internalMutation
    .input({ threadId: v.id("threads") })
    .output(v.from(vThreadDocument))
    .mutation(async ({ args, ctx }) => {
        const oldThread = await ctx.db.get(args.threadId);

        assert(oldThread, `Thread ${args.threadId} not found`);
        await ctx.db.patch(args.threadId, {
            pinnedAt: ctx.now,
            updatedAt: ctx.now,
        });
        const newThread = (await ctx.db.get(args.threadId))!;

        return publicThread(newThread);
    });

export const unpinThread = internalMutation
    .input({ threadId: v.id("threads") })
    .output(v.from(vThreadDocument))
    .mutation(async ({ args, ctx }) => {
        const oldThread = await ctx.db.get(args.threadId);

        assert(oldThread, `Thread ${args.threadId} not found`);
        await patchRow(ctx.db, oldThread, {
            pinnedAt: undefined,
            updatedAt: ctx.now,
        });
        const newThread = (await ctx.db.get(args.threadId))!;

        return publicThread(newThread);
    });

export const listPinnedThreads = query
    .input({ userId: v.string().max(MAX_LENGTH.id) })
    .output(v.from(v.array(vThreadDocument)))
    .query(async ({ args, ctx }) => {
        const identity = await getAuthUserIdentity(ctx);

        if (!identity || identity.userId !== args.userId) {
            return [];
        }

        const threads = await ctx.db
            .query("threads")
            .withIndex("by_user_and_pinned_deleted", (q: any) => q.eq("userId", args.userId).eq("deleted", false).gte("pinnedAt", 0))
            .take(100);

        return threads.filter((t) => t.pinnedAt !== undefined).map((item) => publicThread(item));
    });

// Thread order functions
export const updateThreadOrder = internalMutation
    .input({
        order: v.number(),
        threadId: v.id("threads"),
    })
    .output(v.from(vThreadDocument))
    .mutation(async ({ args, ctx }) => {
        const oldThread = await ctx.db.get(args.threadId);

        assert(oldThread, `Thread ${args.threadId} not found`);
        await ctx.db.patch(args.threadId, {
            order: args.order,
            updatedAt: ctx.now,
        });
        const newThread = (await ctx.db.get(args.threadId))!;

        // Update thread counts aggregate
        // Update thread orders aggregate
        return publicThread(newThread);
    });

export const listThreadOrders = query
    .input({ userId: v.string().max(MAX_LENGTH.id) })
    .output(v.from(v.array(vThreadDocument)))
    .query(async ({ args, ctx }) => {
        const identity = await getAuthUserIdentity(ctx);

        if (!identity || identity.userId !== args.userId) {
            return [];
        }

        // Own rows only (identity checked above); `count()` cannot run behind row-level security.
        const count = await systemDb(ctx).threads.count({ userId: args.userId });

        if (count === 0) {
            return [];
        }

        const MAX_ORDERED_THREADS = 500;
        const threads: Doc<"threads">[] = [];

        const orderedRows = await ctx.db
            .query("threads")
            .withIndex("by_user_and_order", (q) => q.eq("userId", args.userId))
            .order("asc")
            .take(MAX_ORDERED_THREADS);

        for (const threadRow of orderedRows) {
            const thread = threadRow;

            if (thread && !thread.deleted && thread.order !== undefined) {
                threads.push(thread);
            }

            if (threads.length >= MAX_ORDERED_THREADS) {
                break;
            }
        }

        return threads.map((item) => publicThread(item));
    });

// Thread visibility functions
export const updateThreadVisibility = internalMutation
    .input({
        isPublic: v.optional(v.boolean()),
        publicAccessToken: v.optional(v.string()),
        threadId: v.id("threads"),
    })
    .output(v.from(vThreadDocument))
    .mutation(async ({ args, ctx }) => {
        const thread = await ctx.db.get(args.threadId);

        assert(thread, `Thread ${args.threadId} not found`);
        // An absent token REMOVES the stored one — making a thread private must
        // revoke its old link, not leave it valid.
        await patchRow(ctx.db, thread, {
            isPublic: args.isPublic,
            publicAccessToken: args.publicAccessToken,
            updatedAt: ctx.now,
        });
        const newThread = (await ctx.db.get(args.threadId))!;

        return publicThread(newThread);
    });

// Internal: it returns the whole thread row (owner id, system prompt, org/team
// ids). The anonymous share page reads `chat_sharing.getPublicThread`, which
// projects an allow-list instead.
export const getThreadByPublicToken = internalQuery
    .input({ publicAccessToken: v.string() })
    .output(v.from(v.union(vThreadDocument, v.null())))
    .query(async ({ args, ctx }) => {
        const thread = await ctx.db
            .query("threads")
            .withIndex("by_publicAccessToken", (q) => q.eq("publicAccessToken", args.publicAccessToken))
            .first();

        if (!thread || !thread.isPublic || thread.deleted) {
            return null;
        }

        return publicThread(thread);
    });

// Soft delete functions
export const softDeleteThread = internalMutation
    .input({ threadId: v.id("threads") })
    .output(v.from(vThreadDocument))
    .mutation(async ({ args, ctx }) => {
        const oldThread = await ctx.db.get(args.threadId);

        assert(oldThread, `Thread ${args.threadId} not found`);
        await ctx.db.patch(args.threadId, {
            deleted: true,
            deletedAt: ctx.now,
            updatedAt: ctx.now,
        });
        const newThread = (await ctx.db.get(args.threadId))!;

        // Remove from aggregates when soft deleted
        return publicThread(newThread);
    });

export const restoreThread = internalMutation
    .input({ threadId: v.id("threads") })
    .output(v.from(vThreadDocument))
    .mutation(async ({ args, ctx }) => {
        const oldThread = await ctx.db.get(args.threadId);

        assert(oldThread, `Thread ${args.threadId} not found`);
        await patchRow(ctx.db, oldThread, {
            deleted: false,
            deletedAt: undefined,
            updatedAt: ctx.now,
        });
        const newThread = (await ctx.db.get(args.threadId))!;

        // Re-add to aggregates when restored
        return publicThread(newThread);
    });

// Thread settings update
export const updateThreadSettings = internalMutation
    .input({
        patch: v.object({
            customSystemPrompt: v.optional(v.string()),
            dictationLanguage: v.optional(v.string()),
            enabledFeatures: v.optional(v.array(v.string())),
            language: v.optional(v.string()),
            mode: v.optional(v.union(v.literal("text"), v.literal("image"), v.literal("video"))),
            model: v.optional(v.string()),
            reasoningEffort: v.optional(v.number()),
            statelessMode: v.optional(v.boolean()),
        }),
        threadId: v.id("threads"),
    })
    .output(v.from(vThreadDocument))
    .mutation(async ({ args, ctx }) => {
        const thread = await ctx.db.get(args.threadId);

        assert(thread, `Thread ${args.threadId} not found`);

        // Strip explicit `undefined` before patching.
        //
        // Lunora's generated api emits a nested `v.optional()` as a REQUIRED key of
        // type `T | undefined`, so a caller that wants to
        // set one field is pushed into passing `undefined` for the other seven.
        // Spreading those into `ctx.db.patch` would clear fields the caller never
        // mentioned — a partial update that silently is not partial.
        const patch = Object.fromEntries(Object.entries(args.patch).filter(([, value]) => value !== undefined));

        await ctx.db.patch(args.threadId, { ...patch, updatedAt: ctx.now });

        const newThread = (await ctx.db.get(args.threadId))!;

        return publicThread(newThread);
    });

// Thread relationship functions
export const createThreadRelationship = internalMutation
    .input({
        branchPoint: v.optional(v.number()),
        branchType: v.optional(v.union(v.literal("branch"), v.literal("continuation"), v.literal("comparison"))),
        parentThreadId: v.id("threads"),
        threadId: v.id("threads"),
        userId: v.optional(v.string()),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        // If userId not provided, look it up from the thread
        let { userId } = args;

        if (!userId) {
            const thread = await ctx.db.get(args.threadId);

            userId = thread?.userId ?? undefined;
        }

        await ctx.db.insert("threadRelationships", {
            branchPoint: args.branchPoint ?? 0,
            branchType: args.branchType ?? "branch",
            createdAt: ctx.now,
            parentThreadId: args.parentThreadId,
            threadId: args.threadId,
            userId,
        });

        return null;
    });

export const getThreadRelationship = query
    .input({ threadId: v.id("threads") })
    .output(
        v.union(
            v.object({
                _creationTime: v.number(),
                _id: v.id("threadRelationships"),
                branchPoint: v.optional(v.number()),
                branchType: v.optional(v.union(v.literal("branch"), v.literal("continuation"), v.literal("comparison"), v.literal("subagent"))),
                createdAt: v.number(),
                parentThreadId: v.id("threads"),
                threadId: v.id("threads"),
                userId: v.optional(v.string()),
            }),
            v.null(),
        ),
    )
    .query(async ({ args, ctx }) => {
        const identity = await getAuthUserIdentity(ctx);

        if (!identity) {
            return null;
        }

        const thread = await ctx.db.get(args.threadId);

        if (!thread || thread.userId !== identity.userId) {
            return null;
        }

        const relationship = await ctx.db
            .query("threadRelationships")
            .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
            .unique();

        return relationship;
    });

export const getChildThreads = query
    .input({ parentThreadId: v.id("threads") })
    .output(
        v.array(
            v.object({
                _creationTime: v.number(),
                _id: v.id("threadRelationships"),
                branchPoint: v.optional(v.number()),
                branchType: v.optional(v.union(v.literal("branch"), v.literal("continuation"), v.literal("comparison"), v.literal("subagent"))),
                createdAt: v.number(),
                parentThreadId: v.id("threads"),
                threadId: v.id("threads"),
                userId: v.optional(v.string()),
            }),
        ),
    )
    .query(async ({ args, ctx }) => {
        const identity = await getAuthUserIdentity(ctx);

        if (!identity) {
            return [];
        }

        const thread = await ctx.db.get(args.parentThreadId);

        if (!thread || thread.userId !== identity.userId) {
            return [];
        }

        const relationships = await ctx.db
            .query("threadRelationships")
            .withIndex("by_parent_and_thread", (q) => q.eq("parentThreadId", args.parentThreadId))
            .take(200);

        return relationships;
    });

export const deleteThreadRelationship = internalMutation
    .input({ threadId: v.id("threads") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const relationship = await ctx.db
            .query("threadRelationships")
            .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
            .unique();

        if (relationship) {
            await ctx.db.delete(relationship._id);
        }

        return null;
    });

export const listAllThreadRelationships = internalQuery
    .input({ userId: v.optional(v.string()) })
    .output(
        v.array(
            v.object({
                _creationTime: v.number(),
                _id: v.id("threadRelationships"),
                branchPoint: v.optional(v.number()),
                branchType: v.optional(v.union(v.literal("branch"), v.literal("continuation"), v.literal("comparison"), v.literal("subagent"))),
                createdAt: v.number(),
                parentThreadId: v.id("threads"),
                threadId: v.id("threads"),
            }),
        ),
    )
    .query(async ({ args, ctx }) => {
        const MAX_RELATIONSHIPS = 1000;

        if (args.userId) {
            return await ctx.db
                .query("threadRelationships")
                .withIndex("by_userId", (q) => q.eq("userId", args.userId!))
                .order("desc")
                .take(MAX_RELATIONSHIPS);
        }

        return await ctx.db.query("threadRelationships").order("desc").take(MAX_RELATIONSHIPS);
    });

export const getThreadListDataBatch = query
    .input({
        excludeTemporary: v.optional(v.boolean()),
        paginationOpts: v.optional(paginationOptionsValidator),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .query(async ({ args, ctx }) => {
        const identity = await getAuthUserIdentity(ctx);

        if (!identity || identity.userId !== args.userId) {
            return { continueCursor: "" as string, isDone: true, pinnedThreads: [], pins: [], relationships: [], temporaryThreads: [], threads: [] };
        }

        return getThreadListDataBatchHandler(ctx, args);
    });

/**
 * Direct handler for batch thread list data.
 * Exported for hot-path queries to bypass runQuery validator overhead.
 */
export const getThreadListDataBatchHandler = async (
    context: QueryContext,
    args: { excludeTemporary?: boolean; paginationOpts?: { cursor: string | null; numItems: number }; userId: string },
) => {
    const paginationOptions = args.paginationOpts ?? { cursor: null, numItems: 100 };
    const excludeTemporary = args.excludeTemporary ?? true;
    const { userId } = args;
    const now = Date.now();

    // Every read goes through the ORM facade, not the legacy `query().withIndex()`
    // builder. Under row-level security the legacy builder used to drop the SQL
    // LIMIT, so each `take(n)` read the user's WHOLE index range (fixed in
    // `@lunora/server@alpha.145`, anolilab/lunora#822). The facade compiles the
    // policy into SQL and keeps the limit. The orderings
    // are the old index walks spelled out. None depends on another, so all five
    // run at once. `chat/read-cost.test.ts` pins the statement and row counts.
    const [threadsResult, temporaryThreadRecords, pinnedThreadsRaw, ordered, relationships] = await Promise.all([
        // 1. The page (`by_user_and_status`, descending).
        context.db.threads.findMany({
            cursor: paginationOptions.cursor,
            limit: paginationOptions.numItems,
            orderBy: [{ status: "desc" }, { deleted: "desc" }, { _creationTime: "desc" }],
            where: { userId },
        }),
        // 2. Live temporary threads (`by_userId_expiresAt`).
        context.db.temporaryThreads.findMany({
            limit: 200,
            orderBy: [{ expiresAt: "asc" }, { _creationTime: "asc" }],
            where: { expiresAt: { gt: now }, userId },
        }),
        // 3. Pinned (`by_user_and_pinned_deleted`).
        context.db.threads.findMany({
            limit: 100,
            orderBy: [{ pinnedAt: "asc" }, { _creationTime: "asc" }],
            where: { deleted: false, pinnedAt: { gte: 0 }, userId },
        }),
        // 4. Manual order (`by_user_and_order`), ordered threads only. The old
        //    walk also took the never-ordered rows (NULL sorts first) and dropped
        //    them after the limit, so they could crowd ordered ones out. No
        //    `count()` first: an empty result says the same for a statement less.
        context.db.threads.findMany({
            limit: 500,
            orderBy: [{ order: "asc" }, { _creationTime: "asc" }],
            where: { order: { isNull: false }, userId },
        }),
        // 5. Branch/continuation relationships (`by_userId`).
        context.db.threadRelationships.findMany({
            limit: 200,
            orderBy: [{ _creationTime: "asc" }],
            where: { userId },
        }),
    ]);

    const filteredPage = threadsResult.page
        .filter((t) => {
            if (t.deleted) {
                return false;
            }

            if (excludeTemporary && t.isTemporary) {
                return false;
            }

            return true;
        })
        .map((t) => publicThread(t as unknown as Doc<"threads">));

    // One read for every temporary thread, not a `get` each — an un-hinted
    // `get` probes every table. Kept in the records' expiry order.
    const temporaryThreadIds = temporaryThreadRecords.page.map((record) => record.threadId);
    const { page: temporaryThreadRows } =
        temporaryThreadIds.length === 0 ? { page: [] } : await context.db.threads.findMany({ where: { _id: { in: temporaryThreadIds } } });
    const temporaryThreadsById = new Map(temporaryThreadRows.map((thread) => [thread._id as string, thread as unknown as Doc<"threads">]));
    const temporaryThreads = temporaryThreadIds
        .map((threadId) => temporaryThreadsById.get(threadId))
        .filter((t): t is Doc<"threads"> => t !== undefined && !t.deleted)
        .map((item) => publicThread(item));

    const pinnedThreads = pinnedThreadsRaw.page.filter((t) => t.pinnedAt !== undefined).map((item) => publicThread(item as unknown as Doc<"threads">));

    const threadOrders: ThreadDoc[] = [];

    for (const thread of ordered.page) {
        if (!thread.deleted && thread.order !== undefined) {
            threadOrders.push(publicThread(thread as unknown as Doc<"threads">));
        }
    }

    return {
        pinnedThreads,
        relationships: relationships.page.map((r) => {
            return {
                branchPoint: r.branchPoint,
                branchType: r.branchType,
                createdAt: r.createdAt,
                parentThreadId: r.parentThreadId as string,
                threadId: r.threadId as string,
            };
        }),
        temporaryThreads: {
            continueCursor: "",
            isDone: true,
            page: temporaryThreads,
        },
        threadOrders,
        threads: { continueCursor: threadsResult.continueCursor, isDone: threadsResult.isDone, page: filteredPage },
    };
};

/**
 * The full row for the owner or a live grantee, else `null`. `isPublic` grants
 * nothing here: callers (the agent loop) act on the raw row, and a public
 * thread's only non-member view is the redacted one.
 */
export const getThreadWithAccess = internalQuery
    .input({
        threadId: v.id("threads"),
        userId: v.optional(v.string()),
    })
    .query(async ({ args, ctx }) => {
        const access = await resolveThreadReadAccess(ctx, args.threadId, args.userId);

        if (access?.kind !== "full" || access.thread.deleted) {
            return null;
        }

        return publicThread(access.thread);
    });

export const checkThreadAccessBatch = internalQuery
    .input({
        requiredPermission: v.optional(v.union(v.literal("read"), v.literal("write"), v.literal("admin"))),
        threadId: v.id("threads"),
        userId: v.string(),
    })
    .query(async ({ args, ctx }) => checkThreadAccessBatchHandler(ctx, args));

/**
 * Direct handler for batch thread access check.
 * Exported for hot-path queries to bypass runQuery validator overhead.
 *
 * Only FULL access (owner or live grantee) counts — every caller hands the raw
 * row or raw messages on, so a public thread's redacted view is not access here.
 */
export const checkThreadAccessBatchHandler = async (
    context: QueryContext,
    args: { requiredPermission?: ThreadPermission; threadId: Id<"threads">; userId: string },
) => {
    const access = await resolveThreadReadAccess(context, args.threadId, args.userId);

    if (access?.kind !== "full" || !meetsThreadPermission(access.permission, args.requiredPermission ?? "read")) {
        return { hasAccess: false as const, permission: null, thread: null };
    }

    return { hasAccess: true as const, permission: access.permission, thread: publicThread(access.thread) };
};

export const searchThreadsByTitleAndSummary = query
    .input({
        limit: v.number(),
        query: v.string().max(MAX_LENGTH.long),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.from(v.array(vThreadDocument)))
    .query(async ({ args, ctx }) => {
        const identity = await getAuthUserIdentity(ctx);

        if (!identity || identity.userId !== args.userId) {
            return [];
        }

        const [titleMatches, summaryMatches] = await Promise.all([
            ctx.db
                .query("threads")
                .withSearchIndex("title", (q) => q.search("title", args.query).eq("userId", args.userId))
                .take(args.limit),
            ctx.db
                .query("threads")
                .withSearchIndex("summary", (q) => q.search("summary", args.query).eq("userId", args.userId))
                .take(args.limit),
        ]);

        // Deduplicate by _id, title matches first
        const seen = new Set<string>();
        const combined: Doc<"threads">[] = [];

        for (const t of titleMatches) {
            if (t.deleted || t.isTemporary) {
                continue;
            }

            seen.add(t._id);
            combined.push(t);
        }

        for (const t of summaryMatches) {
            if (!seen.has(t._id) && !t.deleted && !t.isTemporary) {
                combined.push(t);
            }
        }

        return combined.slice(0, args.limit).map((item) => publicThread(item));
    });

// Temporary threads functions
export const createTemporaryThread = internalMutation
    .input({
        expiresAt: v.number(),
        retentionHours: v.optional(v.number()),
        threadId: v.id("threads"),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const thread = await ctx.db.get(args.threadId);

        await ctx.db.insert("temporaryThreads", {
            expiresAt: args.expiresAt,
            retentionHours: args.retentionHours,
            threadId: args.threadId,
            userId: thread?.userId,
        });

        // Denormalize isTemporary onto thread for efficient filtering
        if (thread) {
            await ctx.db.patch(args.threadId, { isTemporary: true });
        }

        return null;
    });

export const getTemporaryThreads = query
    .input({
        // The caller's clock, for the expiry filter below. A query must not read it.
        now: v.number(),
        paginationOpts: v.optional(paginationOptionsValidator),
        userId: v.optional(v.string().max(MAX_LENGTH.id)),
    })
    .output(v.from(vPaginationResult(vThreadDocument)))
    .query(async ({ args, ctx }) => {
        const identity = await getAuthUserIdentity(ctx);

        if (!identity) {
            return { continueCursor: "", isDone: true, page: [], pageStatus: null, splitCursor: null };
        }

        // Always scope to authenticated user; ignore caller-supplied userId
        const scopedUserId = identity.userId;
        const { now } = args;

        const allTemporaryThreadRecords = await ctx.db
            .query("temporaryThreads")
            .order("desc")
            .paginate(args.paginationOpts ?? { cursor: null, numItems: 100 });

        const nonExpiredRecords = allTemporaryThreadRecords.page.filter((record) => record.expiresAt > now);

        const threadIds = nonExpiredRecords.map((r) => r.threadId as Id<"threads">);
        const threadsForFilter = await Promise.all(threadIds.map((id) => ctx.db.get(id)));
        const userThreadIds = new Set(
            threadsForFilter.filter((t): t is Doc<"threads"> => t !== null && (t as Doc<"threads">).userId === scopedUserId).map((t) => t._id),
        );
        const filteredRecords = nonExpiredRecords.filter((r) => userThreadIds.has(r.threadId));

        const threads = await Promise.all(filteredRecords.map((record) => ctx.db.get(record.threadId as Id<"threads">)));
        const validThreads = threads.filter((t): t is Doc<"threads"> => t !== null && !(t as Doc<"threads">).deleted);

        return {
            ...allTemporaryThreadRecords,
            page: validThreads.map((item) => publicThread(item)),
        };
    });

export const getTemporaryThread = query
    .input({ threadId: v.id("threads") })
    .output(
        v.union(
            v.object({
                _creationTime: v.number(),
                _id: v.id("temporaryThreads"),
                expiresAt: v.number(),
                retentionHours: v.optional(v.number()),
                threadId: v.id("threads"),
            }),
            v.null(),
        ),
    )
    .query(async ({ args, ctx }) => {
        const identity = await getAuthUserIdentity(ctx);

        if (!identity) {
            return null;
        }

        // Ownership check: only the thread owner sees the expiration row.
        // Otherwise expiresAt becomes a side-channel oracle for any thread id.
        const thread = await ctx.db.get(args.threadId);

        if (!thread || thread.userId !== identity.userId) {
            return null;
        }

        const temporaryThread = await ctx.db
            .query("temporaryThreads")
            .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
            .unique();

        return temporaryThread;
    });

export const updateTemporaryThread = internalMutation
    .input({
        expiresAt: v.number(),
        retentionHours: v.optional(v.number()),
        threadId: v.id("threads"),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const temporaryThread = await ctx.db
            .query("temporaryThreads")
            .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
            .unique();

        if (!temporaryThread) {
            throw new LunoraError("NOT_FOUND", "Temporary thread not found");
        }

        await ctx.db.patch(
            temporaryThread._id,
            withoutUndefined({
                expiresAt: args.expiresAt,
                retentionHours: args.retentionHours,
            }),
        );

        return null;
    });

export const getTemporaryThreadsByThreadIds = query
    .input({ threadIds: v.array(v.id("threads")) })
    .output(v.record(v.id("threads"), v.number()))
    .query(async ({ args, ctx }) => {
        const identity = await getAuthUserIdentity(ctx);

        if (!identity) {
            return {};
        }

        // Ownership filter: only return expiration data for threads owned by
        // the caller. Without this, a caller can submit arbitrary thread ids
        // and learn which exist as temporary plus their expiration timestamps.
        const ownedThreadIds = new Set<string>();

        await Promise.all(
            args.threadIds.map(async (threadId) => {
                const thread = await ctx.db.get(threadId);

                if (thread && thread.userId === identity.userId) {
                    ownedThreadIds.add(threadId);
                }
            }),
        );

        const expiresAtMap = new Map<string, number>();

        const results = await Promise.all(
            args.threadIds
                .filter((id) => ownedThreadIds.has(id))
                .map((threadId) =>
                    ctx.db
                        .query("temporaryThreads")
                        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
                        .unique(),
                ),
        );

        for (const temporaryThread of results) {
            if (temporaryThread) {
                expiresAtMap.set(temporaryThread.threadId, temporaryThread.expiresAt);
            }
        }

        return Object.fromEntries(expiresAtMap);
    });

export const convertTemporaryToPermanent = internalMutation
    .input({ threadId: v.id("threads") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const temporaryThread = await ctx.db
            .query("temporaryThreads")
            .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
            .unique();

        if (!temporaryThread) {
            throw new LunoraError("NOT_FOUND", `Temporary thread ${args.threadId} not found`);
        }

        await ctx.db.delete(temporaryThread._id);
        // Clear denormalized flag
        await patchById(ctx.db, args.threadId, { isTemporary: undefined });

        return null;
    });

export const moveThreadToProject = internalMutation
    .input({
        projectId: v.id("projects"),
        threadId: v.id("threads"),
    })
    .output(v.from(vThreadDocument))
    .mutation(async ({ args, ctx }) => {
        const thread = await ctx.db.get(args.threadId);

        assert(thread, `Thread ${args.threadId} not found`);

        const project = await ctx.db.projects.findFirst({ where: { _id: args.projectId } });

        assert(project, `Project ${args.projectId} not found`);
        await ctx.db.patch(args.threadId, {
            projectId: args.projectId,
            updatedAt: ctx.now,
        });

        const updatedThread = (await ctx.db.get(args.threadId))!;

        return publicThread(updatedThread);
    });

export const removeThreadFromProject = internalMutation
    .input({
        threadId: v.id("threads"),
    })
    .output(v.from(vThreadDocument))
    .mutation(async ({ args, ctx }) => {
        const thread = await ctx.db.get(args.threadId);

        assert(thread, `Thread ${args.threadId} not found`);
        await patchRow(ctx.db, thread, {
            projectId: undefined,
            updatedAt: ctx.now,
        });

        const updatedThread = (await ctx.db.get(args.threadId))!;

        return publicThread(updatedThread);
    });

export const getExpiredTemporaryThreadIds = internalQuery
    .input({ now: v.number() })
    .output(v.array(v.id("threads")))
    .query(async ({ args, ctx }) => {
        // Limit batch size since results are processed via scheduler in batches
        const expiredTemporaryThreads = await ctx.db
            .query("temporaryThreads")
            .withIndex("by_expiresAt", (q) => q.lt("expiresAt", args.now))
            .take(200);

        return expiredTemporaryThreads.map((temporaryThread) => temporaryThread.threadId);
    });

export const deleteExpiredTemporaryThreads = internalMutation
    .input({ threadIds: v.array(v.id("threads")) })
    .output(
        v.object({
            deletedCount: v.number(),
        }),
    )
    .mutation(async ({ args, ctx }) => {
        const recordsToDelete = await Promise.all(
            args.threadIds.map((threadId) =>
                ctx.db
                    .query("temporaryThreads")
                    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
                    .unique(),
            ),
        );

        const validRecords = recordsToDelete.filter((r): r is NonNullable<typeof r> => r !== null);

        await Promise.all([
            ...validRecords.map((record) => ctx.db.delete(record._id)),
            // Clear denormalized isTemporary flag on threads
            ...args.threadIds.map((threadId) => patchById(ctx.db, threadId, { isTemporary: undefined })),
        ]);

        return {
            deletedCount: validRecords.length,
        };
    });

export const getThreadUsage = query
    .input({ threadId: v.id("threads") })
    .output(
        v.object({
            cachedInputTokens: v.optional(v.number()),
            inputTokens: v.number(),
            outputTokens: v.number(),
            reasoningTokens: v.optional(v.number()),
            totalTokens: v.number(),
        }),
    )
    .query(async ({ args, ctx }) => {
        const identity = await getAuthUserIdentity(ctx);

        if (!identity) {
            return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        }

        // Ownership check: token usage stats are user-billing-relevant data and
        // must not leak across thread boundaries.
        const thread = await ctx.db.get(args.threadId);

        if (!thread || thread.userId !== identity.userId) {
            return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        }

        admitOwnedThread(ctx, thread, identity.userId);

        return getThreadUsageHandler(ctx, args);
    });

/**
 * Direct handler for thread usage calculation.
 * Exported for hot-path queries to bypass runQuery validator overhead.
 */
export const getThreadUsageHandler = async (context: QueryContext, args: { threadId: Id<"threads"> }) => {
    // Reduced from 10,000 to 1,000 for 10x speedup
    // Sampling recent messages provides 90%+ accuracy for usage stats
    // Prevents timeout and memory issues on very long threads
    const messages = await context.db
        .query("messages")
        .withIndex("threadId_status_tool_order_stepOrder", (q) => q.eq("threadId", args.threadId))
        .order("desc")
        .take(1000);

    const usage = {
        cachedInputTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
    };

    for (const message of messages) {
        if (!message.usage) {
            continue;
        }

        usage.inputTokens += message.usage.promptTokens || 0;
        usage.outputTokens += message.usage.completionTokens || 0;
        usage.reasoningTokens = (usage.reasoningTokens || 0) + (message.usage.reasoningTokens || 0);
        usage.cachedInputTokens = (usage.cachedInputTokens || 0) + (message.usage.cachedInputTokens || 0);
        usage.totalTokens += message.usage.totalTokens || 0;
    }

    return usage;
};
