import { LunoraError, v } from "lunorash/server";

import type { Id } from "../../_generated/dataModel";
import { authMutation, authQuery, internalQuery, rateLimit } from "../../lib/crpc";
import { MAX_LENGTH } from "../../lib/validators";
import { isThreadLocked } from "../../lib/thread-lock";
import { threadGateOutcome, throwUnlessGranted } from "../lib/thread-gate";
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

        const thread = await context.db.get("threads", threadId as Id<"threads">);

        if (thread && isThreadLocked(thread)) {
            throwUnlessGranted(await threadGateOutcome(context, { level: "read", threadId, unlockProof, userId }));
        }

        const pinId = await context.db.insert("threadPins", {
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
        documentId: v.string().max(MAX_LENGTH.id),
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

        const [existing] = await context.db
            .query("threadPins")
            .withIndex("by_user_and_document", (q) => q.eq("userId", userId).eq("documentId", document._id))
            .take(1);

        if (existing) {
            return existing._id;
        }

        const pinId = await context.db.insert("threadPins", {
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

        context.log.event("chat.create_document_pin", { documentKind: document.kind });

        return pinId;
    });

export const updatePinNote = authMutation
    .use(rateLimit("pins/update"))
    .input({
        note: v.string().max(MAX_LENGTH.long),
        pinId: v.string().max(MAX_LENGTH.id),
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
        context.log.event("chat.delete_pin", { deleted: true });
    });
