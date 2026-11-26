import { LunoraError, v } from "lunorash/server";

import type { Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/internal";
import type { MutationCtx } from "../../_generated/server";
import {
    admitPinWriteAs,
    isAccountMoving,
    isErasing,
    otherPinWritesInFlight,
    PIN_WRITE_LEASE_MS,
    refusesPinWrite,
    releasePinWrite,
} from "../../lib/account-moves";
import { authMutation, authQuery, internalMutation, internalQuery, rateLimit } from "../../lib/crpc";
import { enqueueJob } from "../../lib/job-queue";
import { MAX_LENGTH } from "../../lib/validators";
import { systemDb } from "../../lib/rls/scope";
import { threadGateOutcome, throwUnlessGranted } from "../lib/thread-gate";
import { pinRouteOwnerOf } from "./pin-route-writes";
import { isPinnableDocumentKind } from "./pinnable";

/** The highest image index an image pin may name; a reply has far fewer images. */
export const MAX_PINNED_IMAGE_INDEX = 999;

// What `createPin` takes: a document pin is made by `createDocumentPin` only.
const vPinKind = v.union(v.literal("message"), v.literal("image"));
// What a stored pin can be, as read back.
const vStoredPinKind = v.union(v.literal("message"), v.literal("image"), v.literal("document"));

/**
 * Whether a pin's kind and image fit together: an image pin names the image it pins (its index, and its storage path
 * when it has one), a message pin names neither. Pure; pinned by `pins/functions.test.ts`.
 */
export const isPinShapeValid = ({ imageIndex, imageKey, kind }: { imageIndex?: number; imageKey?: string; kind?: "image" | "message" }): boolean =>
    kind === "image" ? imageIndex !== undefined : imageIndex === undefined && imageKey === undefined;

export const getThreadPins = authQuery
    .input({
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(
        v.array(
            v.object({
                _creationTime: v.number(),
                _id: v.string(),
                createdAt: v.number(),
                documentId: v.optional(v.string()),
                documentKind: v.optional(v.string()),
                imageIndex: v.optional(v.number()),
                imageKey: v.optional(v.string()),
                kind: v.optional(vStoredPinKind),
                messageId: v.optional(v.string()),
                messageRole: v.string(),
                note: v.optional(v.string()),
                selectedText: v.optional(v.string()),
                threadId: v.string(),
                updatedAt: v.number(),
                userId: v.string(),
            }),
        ),
    )
    .query(async ({ args: { threadId, unlockProof }, ctx: context }) => {
        const { userId } = context.user;

        // A pin quotes the chat's messages and documents, so the caller reads them only while the thread's grant stands: a revoked
        // grant reads none, locked or not. The grant is read from the primary, as the write gate reads it.
        if ((await threadGateOutcome(context, { level: "read", primary: true, threadId, unlockProof, userId })) !== "ok") {
            return [];
        }

        const pins = await context.db
            .query("threadPins")
            .withIndex("by_user_and_thread", (q) => q.eq("userId", userId).eq("threadId", threadId as Id<"threads">))
            .order("desc")
            .take(200);

        return pins;
    });

const PIN_EXPORT_PAGE = 100;

/**
 * One page of the caller's pins on a thread, for the owner's data export (`gdpr/steps.ts#collectConversations`), which reads
 * pages until `isDone`. A pin is the author's own record, so only the caller's pins are read: someone else's pin on the
 * thread is theirs.
 */
export const listPinsForExport = internalQuery
    .input({
        cursor: v.union(v.string().max(MAX_LENGTH.cursor), v.null()),
        threadId: v.id("threads"),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(
        v.object({
            continueCursor: v.union(v.string(), v.null()),
            isDone: v.boolean(),
            page: v.array(
                v.object({
                    _id: v.string(),
                    createdAt: v.number(),
                    documentId: v.optional(v.string()),
                    documentKind: v.optional(v.string()),
                    imageIndex: v.optional(v.number()),
                    imageKey: v.optional(v.string()),
                    kind: v.optional(vStoredPinKind),
                    messageId: v.optional(v.string()),
                    messageRole: v.string(),
                    note: v.optional(v.string()),
                    selectedText: v.optional(v.string()),
                    updatedAt: v.number(),
                }),
            ),
        }),
    )
    .query(async ({ args, ctx: context }) => {
        const result = await context.db
            .query("threadPins")
            .withIndex("by_user_and_thread", (q) => q.eq("userId", args.userId).eq("threadId", args.threadId))
            .paginate({ cursor: args.cursor, numItems: PIN_EXPORT_PAGE });

        return {
            continueCursor: result.continueCursor,
            isDone: result.isDone,
            page: result.page.map((pin) => {
                return {
                    _id: pin._id,
                    createdAt: pin.createdAt,
                    documentId: pin.documentId,
                    documentKind: pin.documentKind,
                    imageIndex: pin.imageIndex,
                    imageKey: pin.imageKey,
                    kind: pin.kind,
                    messageId: pin.messageId,
                    messageRole: pin.messageRole,
                    note: pin.note,
                    selectedText: pin.selectedText,
                    updatedAt: pin.updatedAt,
                };
            }),
        };
    });

/**
 * The threads another user owns where the caller has pinned something, each with its owner: the export reads the caller's pins
 * on them from the owner's shard (`gdpr/steps.ts#collectSharedPins`). The routes outlive the grant, so a revoked collaborator's
 * pins still export.
 */
export const listSharedPinRoutesForExport = internalQuery
    .input({
        cursor: v.union(v.string().max(MAX_LENGTH.cursor), v.null()),
        // Routes per page, at most the export's page. The owner sweep asks for fewer, so one action stays within its shard-call budget.
        limit: v.optional(v.number()),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(
        v.object({
            continueCursor: v.union(v.string(), v.null()),
            isDone: v.boolean(),
            page: v.array(v.object({ ownerId: v.string(), threadId: v.string() })),
        }),
    )
    .query(async ({ args, ctx: context }) => {
        // One bounded page per call: the export reads the next page until the last, so no result carries every route at once.
        const result = await context.db.sharedPinRoutes.findMany({
            consistency: "primary",
            cursor: args.cursor ?? undefined,
            limit: Math.min(Math.max(args.limit ?? PIN_EXPORT_PAGE, 1), PIN_EXPORT_PAGE),
            where: { userId: args.userId },
        });

        return {
            continueCursor: result.continueCursor ?? null,
            isDone: result.isDone,
            page: result.page.map((route) => {
                return { ownerId: route.ownerId, threadId: route.threadId };
            }),
        };
    });

/**
 * Records where the caller's pin on `threadId` lives when the caller is not the thread's owner, so the caller's export still finds
 * it once their grant is revoked. Runs on the owner's shard, where the pin is written.
 */
const recordSharedPinRoute = async (context: MutationCtx, threadId: Id<"threads">, userId: string, now: number): Promise<void> => {
    // The owner is read past row-level security: a collaborator is not the thread row's reader, so the caller's own view cannot give it.
    const thread = await systemDb(context).get("threads", threadId);

    if (thread?.userId === undefined || thread.userId === userId) {
        return;
    }

    const existing = await context.db.sharedPinRoutes.findFirst({ consistency: "primary", where: { threadId, userId } });

    if (existing) {
        return;
    }

    await context.db.insert("sharedPinRoutes", { createdAt: now, ownerId: thread.userId, threadId, userId });
};

/** The routes one mutation deletes at most. The rest go by a continuation job, so no mutation's writes grow with the route count. */
const ROUTE_CLEANUP_BATCH = 100;

/**
 * Schedules a route cleanup for after this mutation commits. `ctx.scheduler` is rolled back with the mutation, so a pin delete that fails
 * schedules nothing and removes no route, and the job never reads a pin the commit has not yet removed. `enqueueJob` is sent at once and
 * not undone, so it could run first and then fail the mutation after its routes were gone.
 */
const scheduleRouteCleanup = async (
    context: MutationCtx,
    threadId: Id<"threads">,
    userId: string,
    options: { delayMs?: number; survivesRollback?: boolean } = {},
): Promise<void> => {
    const { delayMs = 0, survivesRollback = false } = options;

    if (!survivesRollback) {
        await context.scheduler.runAfter(delayMs, internal.chat.pins.functions.finishPinRouteCleanup, { threadId, userId });

        return;
    }

    // A refused write rethrows, which rolls back a scheduled job while the route changes it made stay. So its cleanup goes by a queue
    // send, which a rollback does not undo: the job runs whether or not the refusal does.
    const thread = await systemDb(context).get("threads", threadId);

    if (thread?.userId !== undefined) {
        await enqueueJob(internal.chat.pins.functions.finishPinRouteCleanup, { threadId, userId }, { delayMs, shardKey: thread.userId });
    }
};

/**
 * Removes one batch of the caller's routes to a thread, once the caller holds no pin there: nothing is left to find through them. The
 * same rule runs when the last pin goes (`deletePin`). A full batch means more may remain, so a job on the thread owner's shard finishes
 * them (`finishPinRouteCleanup`); that job re-checks the pins and the in-flight writes, so it can run again safely.
 */
export const dropRoutesWithoutPins = async (
    context: MutationCtx,
    threadId: Id<"threads">,
    userId: string,
    writerId: string | null = null,
    refusal = false,
): Promise<void> => {
    const left = await context.db
        .query("threadPins")
        .withIndex("by_user_and_thread", (q) => q.eq("userId", userId).eq("threadId", threadId))
        .take(1);

    if (left.length > 0) {
        return;
    }

    // Nothing to remove, and the merge wait below reschedules itself: an owner, who keeps no route to their thread, schedules nothing.
    if ((await pinRouteOwnerOf(context.db, userId, threadId)) === null) {
        return;
    }

    // A guest merge is moving this account's pins, and the route it has not transferred yet is still the only way to find them: none is
    // taken until the merge ends. An erasure is not waited for: its drain removes every route, and a refused write takes back its own.
    if ((await isAccountMoving(context, userId, Date.now())) && !(await isErasing(context, userId))) {
        await scheduleRouteCleanup(context, threadId, userId, { delayMs: PIN_WRITE_LEASE_MS, survivesRollback: refusal });

        return;
    }

    // A guest merge can leave more than one route for the same user and thread, and a survivor is a link: every route goes.
    const { page } = await context.db.sharedPinRoutes.findMany({ consistency: "primary", limit: ROUTE_CLEANUP_BATCH, where: { threadId, userId } });

    for (const route of page) {
        await context.db.delete("sharedPinRoutes", route._id);
    }

    // A write admitted before the delete may have read its route and still be about to insert its pin, on a route that is now gone. So
    // the batch goes back, and the job removes it once no write is in flight. A write admitted after the delete finds no route and
    // writes its own. The clock is read here, not taken from the mutation's start: a lease that ran out during a slow mutation is out.
    if (await otherPinWritesInFlight(context, userId, writerId, Date.now())) {
        for (const route of page) {
            await context.db.insert("sharedPinRoutes", { createdAt: route.createdAt, ownerId: route.ownerId, threadId, userId });
        }

        await scheduleRouteCleanup(context, threadId, userId, { delayMs: PIN_WRITE_LEASE_MS, survivesRollback: refusal });

        return;
    }

    if (page.length < ROUTE_CLEANUP_BATCH) {
        return;
    }

    await scheduleRouteCleanup(context, threadId, userId, { survivesRollback: refusal });
};

/**
 * One pass of a route cleanup, on the shard the thread is on: it does nothing where the thread is no longer (a guest merge moved it). It
 * waits while another admitted pin write of the account is in flight, then removes the routes it has no pin for (`dropRoutesWithoutPins`).
 */
export const finishRouteCleanup = async (context: MutationCtx, threadId: Id<"threads">, userId: string): Promise<void> => {
    const thread = await systemDb(context).get("threads", threadId);

    // This shard cannot see the pins of a thread that moved off it, so it cannot tell whether any are left: the routes stay.
    if (!thread) {
        return;
    }

    // The thread's owner is merging: the thread and its pins are moving to another shard, and this shard's view is partial until the
    // merge ends. The routes name the owner, and the merge re-points them, so this job takes none.
    if (thread.userId !== undefined && (await isAccountMoving(context, thread.userId, Date.now()))) {
        return;
    }

    // Nothing to remove: an owner keeps no route to their own thread, so a cleanup there schedules no further pass.
    if ((await pinRouteOwnerOf(context.db, userId, threadId)) === null) {
        return;
    }

    if (await otherPinWritesInFlight(context, userId, null, Date.now())) {
        await scheduleRouteCleanup(context, threadId, userId, { delayMs: PIN_WRITE_LEASE_MS });

        return;
    }

    await dropRoutesWithoutPins(context, threadId, userId);
};

/**
 * Finishes a route cleanup that `dropRoutesWithoutPins` left unfinished. It waits while another admitted pin write of the account is in
 * flight, since that write may still use the route, and then removes the next batch. Safe to run again: it only deletes routes the
 * caller has no pin for.
 */
export const finishPinRouteCleanup = internalMutation
    .input({ threadId: v.string().max(MAX_LENGTH.id), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args: { threadId, userId }, ctx: context }) => {
        await finishRouteCleanup(context, threadId as Id<"threads">, userId);

        return null;
    });

/**
 * Writes a pin with its route. The route is a global row, outside this shard's transaction, so it is written BEFORE the pin: a
 * committed pin always has its route (erasure after a revoked grant finds the pin through it). A failed pin write leaves its route
 * behind on purpose. Removing it could race a concurrent writer that found the same route and is about to commit its own pin; a
 * route with no pin is harmless (every reader skips it), and account and thread deletion remove it.
 *
 * The one exception is a refusal: the account is being erased, so the route must not outlive it. A refused write can run after the
 * erasure's route drain (the route write is not in the refused transaction), so it takes the route back when the caller has no pin
 * on the thread and no other admitted write of the account is still in flight. A route that an in-flight write may still use stays:
 * the erasure waits for every admitted write to pass before it sweeps and drains, so such a route is drained with the rest.
 */
export const withSharedPinRoute = async <T>(
    context: MutationCtx,
    threadId: Id<"threads">,
    userId: string,
    now: number,
    write: () => Promise<T>,
    writerId: string | null = null,
): Promise<T> => {
    await recordSharedPinRoute(context, threadId, userId, now);

    try {
        return await write();
    } catch (error) {
        if (error instanceof LunoraError && error.code === "FORBIDDEN") {
            // This write's own lease goes first, so it does not hold back its own cleanup.
            if (writerId !== null) {
                await releasePinWrite(context, userId, writerId);
            }

            await dropRoutesWithoutPins(context, threadId, userId, writerId, true);
        }

        throw error;
    }
};

/**
 * Deletes one user's pins on one thread, on the thread owner's shard where a collaborator's pins are written. Account erasure calls it
 * for each route before the routes go (`gdpr/steps.ts#erasePinsOnOwnerShards`).
 */
export const eraseUserPinsOnThread = internalMutation
    .input({ threadId: v.id("threads"), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ args, ctx: context }) => {
        // One batch per call, so one transaction stays bounded; the caller repeats the call while `hasMore`. A deleted pin leaves the index.
        const batch = await context.db
            .query("threadPins")
            .withIndex("by_user_and_thread", (q) => q.eq("userId", args.userId).eq("threadId", args.threadId))
            .take(PIN_EXPORT_PAGE);

        for (const pin of batch) {
            await context.db.delete("threadPins", pin._id);
        }

        return { hasMore: batch.length === PIN_EXPORT_PAGE };
    });

/**
 * Moves one guest's pins on one thread to the new account, on the thread owner's shard, so a guest conversion keeps the pins the guest
 * made on a shared thread (`lib/account-merge.ts#runGuestMerge`). Moves nothing once an erasure of either account has begun
 * (`erasing`): the merge's lease lives on the new account's shard, out of reach here, so the erasure marker is the fence read
 * where the pins are written; a delivery that lost its lease while an erasure stopped the merge cannot hand the erased pins on.
 */
export const reassignUserPinsOnThread = internalMutation
    .input({ from: v.string().max(MAX_LENGTH.id), threadId: v.id("threads"), to: v.string().max(MAX_LENGTH.id) })
    .output(v.object({ erasing: v.optional(v.boolean()), hasMore: v.boolean() }))
    .mutation(async ({ args, ctx: context }) => {
        if ((await isErasing(context, args.from)) || (await isErasing(context, args.to))) {
            return { erasing: true, hasMore: false };
        }

        // One batch per call; the caller repeats it while `hasMore`. A pin the new account already has for the same document is dropped
        // instead of moved, so the account keeps one pin per document.
        const batch = await context.db
            .query("threadPins")
            .withIndex("by_user_and_thread", (q) => q.eq("userId", args.from).eq("threadId", args.threadId))
            .take(PIN_EXPORT_PAGE);

        for (const pin of batch) {
            const { documentId } = pin;
            const sameDocument =
                documentId === undefined
                    ? []
                    : await context.db
                          .query("threadPins")
                          .withIndex("by_user_and_document", (q) => q.eq("userId", args.to).eq("documentId", documentId))
                          .take(1);
            const [kept] = sameDocument;

            if (kept) {
                // The account keeps its one pin, and the guest's note is not lost with the duplicate: both notes are kept, in order.
                const notes = [kept.note, pin.note].filter((note): note is string => typeof note === "string" && note.length > 0);
                const merged = notes.join("\n\n");

                if (merged !== (kept.note ?? "")) {
                    await context.db.patch("threadPins", kept._id, { note: merged, updatedAt: context.now });
                }

                await context.db.delete("threadPins", pin._id);
            } else {
                await context.db.patch("threadPins", pin._id, { userId: args.to });
            }
        }

        return { hasMore: batch.length === PIN_EXPORT_PAGE };
    });

export const createPin = authMutation
    .use(rateLimit("pins/create"))
    .input({
        imageIndex: v.optional(v.number().int().min(0).max(MAX_PINNED_IMAGE_INDEX)),
        // The image's key, a hash the web app matches against the message's images when the pin is shown; no address.
        imageKey: v.optional(v.string().max(MAX_LENGTH.short)),
        // Absent or "message" pins the whole message; "image" pins the image at `imageIndex`.
        kind: v.optional(vPinKind),
        messageId: v.string().max(MAX_LENGTH.id),
        messageRole: v.string().max(MAX_LENGTH.short),
        selectedText: v.optional(v.string().max(MAX_LENGTH.document)),
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(v.string())
    .mutation(async ({ args: { imageIndex, imageKey, kind, messageId, messageRole, selectedText, threadId, unlockProof }, ctx: context }) => {
        const { userId } = context.user;
        const { now } = context;

        if (!isPinShapeValid({ imageIndex, imageKey, kind })) {
            throw new LunoraError("BAD_REQUEST", "An image pin names the part it pins; a message pin names none");
        }

        // A pin is listed only through the thread's read grant (`getThreadPins`), so it is written only under that grant, locked or not.
        throwUnlessGranted(await threadGateOutcome(context, { level: "read", primary: true, threadId, unlockProof, userId }));

        // A refused write adds no lease; an admitted one adds its own, which lasts until it expires (`lib/account-moves.ts`).
        const writerId = await admitPinWriteAs(context, userId, now);

        if (writerId === null) {
            throw new LunoraError("FORBIDDEN", "Pins cannot be added while this account is being moved or erased");
        }

        const pinId = await withSharedPinRoute(
            context,
            threadId as Id<"threads">,
            userId,
            now,
            async () => {
                // The last check, after the route write and right before the insert. No external call sits between them, so an erasure
                // that fences this shard either runs before this check (the write is refused) or after the insert (its sweep sees the pin).
                if (await refusesPinWrite(context, userId, now)) {
                    throw new LunoraError("FORBIDDEN", "Pins cannot be added while this account is being moved or erased");
                }

                return await context.db.insert("threadPins", {
                    createdAt: now,
                    // A message pin is stored as before (no kind), so old and new rows read the same.
                    ...(kind === "image" && { imageIndex, kind }),
                    ...(kind === "image" && imageKey !== undefined && { imageKey }),
                    messageId,
                    messageRole,
                    selectedText,
                    threadId: threadId as Id<"threads">,
                    updatedAt: now,
                    userId,
                });
            },
            writerId,
        );

        context.log.event("chat.create_pin", { hasSelectedText: selectedText !== undefined, kind: kind ?? "message", messageRole });

        return pinId;
    });

/**
 * Pins a finished visual or plan of the thread (`PINNABLE_DOCUMENT_KINDS`). The label is the document's own title, read
 * here rather than sent, and the pin quotes the message that made the document when it has one. Pinning a document that
 * is already pinned returns that pin, so one document is one pin.
 */
export const createDocumentPin = authMutation
    .use(rateLimit("pins/create"))
    .input({
        documentId: v.id("documents"),
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(v.string())
    .mutation(async ({ args: { documentId, threadId, unlockProof }, ctx: context }) => {
        const { userId } = context.user;
        const { now } = context;

        // Every document pin is read through the gate, locked or not: a thread the caller has no grant for is not found,
        // and an unlocked shared thread is readable only with its read grant. The grant is read from the primary, so a
        // replica that still holds a revoked grant cannot admit the write.
        throwUnlessGranted(await threadGateOutcome(context, { level: "read", primary: true, threadId, unlockProof, userId }));

        const document = await context.db.get("documents", documentId as Id<"documents">);

        if (!document || document.threadId !== threadId) {
            throw new LunoraError("NOT_FOUND", "Document not found in this chat");
        }

        if (!isPinnableDocumentKind(document.kind)) {
            throw new LunoraError("BAD_REQUEST", "Only visuals and plans can be pinned");
        }

        if (document.status === "streaming") {
            throw new LunoraError("BAD_REQUEST", "A document still being written cannot be pinned yet");
        }

        // A pin that already exists is returned as it is: no write, so no lease is renewed for it.
        const [existing] = await context.db
            .query("threadPins")
            .withIndex("by_user_and_document", (q) => q.eq("userId", userId).eq("documentId", document._id))
            .take(1);

        if (existing) {
            return existing._id;
        }

        // A refused write adds no lease; an admitted one adds its own, which lasts until it expires (`lib/account-moves.ts`).
        const writerId = await admitPinWriteAs(context, userId, now);

        if (writerId === null) {
            throw new LunoraError("FORBIDDEN", "Pins cannot be added while this account is being moved or erased");
        }

        const pinId = await withSharedPinRoute(
            context,
            threadId as Id<"threads">,
            userId,
            now,
            async () => {
                // The last check, as in `createPin`: after the route write, right before the insert.
                if (await refusesPinWrite(context, userId, now)) {
                    throw new LunoraError("FORBIDDEN", "Pins cannot be added while this account is being moved or erased");
                }

                return await context.db.insert("threadPins", {
                    createdAt: now,
                    documentId: document._id,
                    documentKind: document.kind,
                    kind: "document",
                    messageId: document.messageId,
                    // Documents are made by the assistant, so the quoted message is an assistant message.
                    messageRole: "assistant",
                    selectedText: document.title,
                    threadId: threadId as Id<"threads">,
                    updatedAt: now,
                    userId,
                });
            },
            writerId,
        );

        context.log.event("chat.create_document_pin", { documentKind: document.kind });

        return pinId;
    });

export const updatePinNote = authMutation
    .use(rateLimit("pins/update"))
    .input({
        note: v.string().max(MAX_LENGTH.long),
        pinId: v.string().max(MAX_LENGTH.id),
        // The pin's thread: a collaborator's pin is stored on the thread owner's shard, and the call routes there by this id.
        threadId: v.optional(v.id("threads")),
    })
    .mutation(async ({ args: { note, pinId }, ctx: context }) => {
        const { userId } = context.user;
        const pin = await context.db.get("threadPins", pinId as Id<"threadPins">);

        if (!pin) {
            throw new LunoraError("NOT_FOUND", "Pin not found");
        }

        if (pin.userId !== userId) {
            throw new LunoraError("FORBIDDEN", "Cannot update another user's pin");
        }

        await context.db.patch("threadPins", pinId as Id<"threadPins">, {
            note,
            updatedAt: context.now,
        });
        context.log.event("chat.update_pin_note", { cleared: note.length === 0 });
    });

export const updatePinSelectedText = authMutation
    .use(rateLimit("pins/update"))
    .input({
        pinId: v.string().max(MAX_LENGTH.id),
        selectedText: v.string().max(MAX_LENGTH.document),
        // The pin's thread: a collaborator's pin is stored on the thread owner's shard, and the call routes there by this id.
        threadId: v.optional(v.id("threads")),
    })
    .mutation(async ({ args: { pinId, selectedText }, ctx: context }) => {
        const { userId } = context.user;
        const pin = await context.db.get("threadPins", pinId as Id<"threadPins">);

        if (!pin) {
            throw new LunoraError("NOT_FOUND", "Pin not found");
        }

        if (pin.userId !== userId) {
            throw new LunoraError("FORBIDDEN", "Cannot update another user's pin");
        }

        await context.db.patch("threadPins", pinId as Id<"threadPins">, {
            selectedText,
            updatedAt: context.now,
        });
        context.log.event("chat.update_pin_selected_text", { cleared: selectedText.length === 0 });
    });

export const deletePin = authMutation
    .use(rateLimit("pins/delete"))
    .input({
        pinId: v.string().max(MAX_LENGTH.id),
        // The pin's thread: a collaborator's pin is stored on the thread owner's shard, and the call routes there by this id.
        threadId: v.optional(v.id("threads")),
    })
    .mutation(async ({ args: { pinId }, ctx: context }) => {
        const { userId } = context.user;
        const pin = await context.db.get("threadPins", pinId as Id<"threadPins">);

        if (!pin) {
            throw new LunoraError("NOT_FOUND", "Pin not found");
        }

        if (pin.userId !== userId) {
            throw new LunoraError("FORBIDDEN", "Cannot delete another user's pin");
        }

        await context.db.delete("threadPins", pinId as Id<"threadPins">);

        // Only a collaborator holds a route to the thread. After this commits, the job finds the pin gone, or a pin a later write committed,
        // and removes the routes only if none is left.
        if ((await pinRouteOwnerOf(context.db, userId, pin.threadId)) !== null) {
            await scheduleRouteCleanup(context, pin.threadId, userId);
        }

        context.log.event("chat.delete_pin", { deleted: true });
    });
