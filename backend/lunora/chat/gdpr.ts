/**
 * The chat module's erasure for account deletion (`gdpr/steps/deletion-steps.ts`
 * and `residual-deletion-steps.ts` call these). Plain functions over the caller's
 * `ctx`, so the deletes stay in the orchestrator's mutation and the writes are
 * the owner's. Batching follows `gdpr/batch.ts`.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { dropGuestLinkRoutes } from "./lib/guest-link-store";
import { BATCH, type BatchResult, deleteParentsWithChildren } from "../gdpr/batch";

/**
 * The pin routes that name the user, as the collaborator who pinned or as the owner of the thread: a route names no one else, so
 * it goes with the account.
 */
export const eraseSharedPinRoutesBatch = async (ctx: MutationCtx, userId: string): Promise<{ hasMore: boolean }> => {
    let hasMore = false;

    for (const where of [{ userId }, { ownerId: userId }]) {
        const { page } = await ctx.db.sharedPinRoutes.findMany({ consistency: "primary", limit: BATCH, where });

        for (const route of page) {
            await ctx.db.delete("sharedPinRoutes", route._id);
        }

        if (page.length === BATCH) {
            hasMore = true;
        }
    }

    // Owed restores name the user the same way. This drain runs after the owner-shard sweeps, so each write that could need one has passed:
    // a row still here needs no route any more. It is never dropped before the sweeps, which turn it into a route (`materializePendingPinRoutesBatch`).
    for (const where of [{ userId }, { ownerId: userId }]) {
        const { page } = await ctx.db.pendingPinRestores.findMany({ consistency: "primary", limit: BATCH, where });

        for (const row of page) {
            await ctx.db.delete("pendingPinRestores", row._id);
        }

        if (page.length === BATCH) {
            hasMore = true;
        }
    }

    return { hasMore };
};

/**
 * One batch of the owed restores (`pendingPinRestores`) that name the user as the collaborator, each made into its route where the route is not
 * already there. The owner-shard sweep that follows then finds the pins they lead to. The restore may not have run yet: the cron pass is a minute
 * behind the queue. The route it would write exists now, so its row is settled here.
 */
export const materializePendingPinRoutesBatch = async (ctx: MutationCtx, userId: string): Promise<{ hasMore: boolean }> => {
    const { page } = await ctx.db.pendingPinRestores.findMany({ consistency: "primary", limit: BATCH, where: { userId } });

    for (const row of page) {
        if (row.ownerId !== userId) {
            const { page: routes } = await ctx.db.sharedPinRoutes.findMany({
                consistency: "primary",
                limit: BATCH,
                where: { threadId: row.threadId, userId },
            });

            if (routes.every((route) => route.ownerId !== row.ownerId)) {
                await ctx.db.insert("sharedPinRoutes", { createdAt: row.routeCreatedAt, ownerId: row.ownerId, threadId: row.threadId, userId });
            }
        }

        await ctx.db.delete("pendingPinRestores", row._id);
    }

    return { hasMore: page.length === BATCH };
};

/**
 * One batch of the user's pins and tags (relationships, grants and passcodes are `agent/gdpr.ts`; goals go in batches with the run
 * state, {@link erasePersistentStreamsForUser}). The deletion workflow drains it (`gdpr/steps/deletion-steps.ts`), so no call holds an
 * unbounded set.
 */
export const eraseThreadPinsAndTagsBatch = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const [pins, threadTags] = await Promise.all([
        ctx.db
            .query("threadPins")
            .withIndex("by_user_and_thread", (q) => q.eq("userId", userId))
            .take(BATCH),
        ctx.db
            .query("threadTags")
            .withIndex("by_user_and_order", (q) => q.eq("userId", userId))
            .take(BATCH),
    ]);

    await Promise.all([...pins.map((p) => ctx.db.delete("threadPins", p._id)), ...threadTags.map((tag) => ctx.db.delete("threadTags", tag._id))]);

    return { hasMore: pins.length >= BATCH || threadTags.length >= BATCH };
};

/**
 * Tool-approval snapshots, requested secrets (ciphertext the user handed the
 * agent) and goals, then a stream per reply and every chunk of it. The approval
 * snapshots carry the run's final system prompt, which can hold memory and
 * personalisation text; a goal carries the goal text and every verdict. One batch
 * of each per call.
 */
export const erasePersistentStreamsForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const [streams, approvalRuns, secrets, goals, guestMessages, guestLinks] = await Promise.all([
        ctx.db
            .query("persistentStreams")
            .withIndex("by_userId_status", (q) => q.eq("userId", userId))
            .take(BATCH),
        ctx.db
            .query("toolApprovalRuns")
            .withIndex("by_userId_status_createdAt", (q) => q.eq("userId", userId))
            .take(BATCH),
        ctx.db
            .query("requestedSecrets")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .take(BATCH),
        ctx.db
            .query("threadGoals")
            .withIndex("by_user", (q) => q.eq("userId", userId))
            .take(BATCH),
        // Text strangers left for the user, then the links that took it (the route to a link goes with `shardRoutes`' owner).
        ctx.db
            .query("threadGuestMessages")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .take(BATCH),
        ctx.db
            .query("threadGuestLinks")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .take(BATCH),
    ]);

    await Promise.all([
        ...approvalRuns.map(async (row) => await ctx.db.delete("toolApprovalRuns", row._id)),
        ...secrets.map(async (row) => await ctx.db.delete("requestedSecrets", row._id)),
        ...goals.map(async (row) => await ctx.db.delete("threadGoals", row._id)),
        ...guestMessages.map(async (row) => await ctx.db.delete("threadGuestMessages", row._id)),
    ]);

    // A link is removed only once no guest message can still reference it: a short batch of messages drained them all.
    // Otherwise the links wait for the next call, which `hasMore` below asks for.
    const messagesDrained = guestMessages.length < BATCH;

    if (messagesDrained) {
        await Promise.all(guestLinks.map(async (row) => await ctx.db.delete("threadGuestLinks", row._id)));
        // A route that fails to drop is logged, not thrown: a leftover route answers "not active", and the erasure must not stall on it.
        await dropGuestLinkRoutes(
            ctx,
            guestLinks.map((link) => link.linkHash),
        );
    }

    const streamsLeft = await deleteParentsWithChildren(
        streams,
        async (stream) =>
            await ctx.db
                .query("persistentChunks")
                .withIndex("by_streamId_seq", (q) => q.eq("streamId", stream._id))
                .take(BATCH),
        {
            child: (chunk) => ctx.db.delete("persistentChunks", chunk._id),
            parent: (stream) => ctx.db.delete("persistentStreams", stream._id),
        },
    );

    return {
        hasMore:
            streamsLeft ||
            approvalRuns.length >= BATCH ||
            secrets.length >= BATCH ||
            goals.length >= BATCH ||
            guestMessages.length >= BATCH ||
            (messagesDrained && guestLinks.length >= BATCH),
    };
};

/** The user's presentations, each after its slides. */
export const erasePresentationsForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const presentations = await ctx.db
        .query("presentations")
        .withIndex("by_user_and_thread", (q) => q.eq("userId", userId))
        .take(BATCH);

    const hasMore = await deleteParentsWithChildren(
        presentations,
        async (presentation) =>
            await ctx.db
                .query("presentationSlides")
                .withIndex("by_presentation_and_number", (q) => q.eq("presentationId", presentation._id))
                .take(BATCH),
        {
            child: (slide) => ctx.db.delete("presentationSlides", slide._id),
            parent: (presentation) => ctx.db.delete("presentations", presentation._id),
        },
    );

    return { hasMore };
};

/**
 * Deletes the pins that name each of the given documents, one batch per document, on the thread's shard where the document is. Returns
 * the ids of the documents whose pins are all gone; a document with more pins left than one batch is not in it, and the caller keeps it
 * for the next round.
 */
export const erasePinsNamingDocuments = async (ctx: MutationCtx, documents: ReadonlyArray<Doc<"documents">>): Promise<Set<string>> => {
    const drained = new Set<string>();
    // One budget for the whole call: a call deletes at most one batch of pins across every document, so its transaction stays bounded.
    let budget = BATCH;

    for (const documentRow of documents) {
        if (budget === 0) {
            break;
        }

        const take = budget;
        const pins = await ctx.db
            .query("threadPins")
            .withIndex("by_thread_and_document", (q) => q.eq("threadId", documentRow.threadId).eq("documentId", documentRow._id))
            .take(take);

        for (const pin of pins) {
            await ctx.db.delete("threadPins", pin._id);
        }

        budget -= pins.length;

        if (pins.length < take) {
            drained.add(documentRow._id);
        }
    }

    return drained;
};

/**
 * A deleted thread takes its pins and the collaborator routes that name it: both sit on the thread owner's shard (the routes in the
 * global table), so the owner's hard delete removes them. One batch of each per call, so no call grows with the thread: the caller
 * repeats it while `hasMore` (the thread's delete chain, `agent/threads.ts`, reschedules itself).
 */
export const eraseThreadPinsAndRoutesBatch = async (ctx: MutationCtx, threadId: Id<"threads">): Promise<BatchResult> => {
    const pins = await ctx.db
        .query("threadPins")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .take(BATCH);

    for (const pin of pins) {
        await ctx.db.delete("threadPins", pin._id);
    }

    const { page } = await ctx.db.sharedPinRoutes.findMany({ consistency: "primary", limit: BATCH, where: { threadId } });

    for (const route of page) {
        await ctx.db.delete("sharedPinRoutes", route._id);
    }

    // An owed restore names the thread, and so it goes with the thread: there is no route left for it to write.
    const { page: owed } = await ctx.db.pendingPinRestores.findMany({ consistency: "primary", limit: BATCH, where: { threadId } });

    for (const row of owed) {
        await ctx.db.delete("pendingPinRestores", row._id);
    }

    return { hasMore: pins.length >= BATCH || page.length >= BATCH || owed.length >= BATCH };
};
