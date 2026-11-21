import { LunoraError, v } from "lunorash/server";

import type { Id } from "../../_generated/dataModel";
import { authMutation, authQuery, rateLimit } from "../../lib/crpc";
import { MAX_LENGTH } from "../../lib/validators";
import { isThreadLocked } from "../../lib/thread-lock";
import { threadGateOutcome, throwUnlessGranted } from "../lib/thread-gate";

/** The highest image index an image pin may name; a reply has far fewer images. */
export const MAX_PINNED_IMAGE_INDEX = 999;

const vPinKind = v.union(v.literal("message"), v.literal("image"));

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
                imageIndex: v.optional(v.number()),
                imageKey: v.optional(v.string()),
                kind: v.optional(vPinKind),
                messageId: v.string(),
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

        // A pin quotes the chat's messages: a locked chat's pins need its proof.
        const thread = await context.db.get("threads", threadId as Id<"threads">);

        if (thread && isThreadLocked(thread) && (await threadGateOutcome(context, { level: "read", threadId, unlockProof, userId })) !== "ok") {
            return [];
        }

        const pins = await context.db
            .query("threadPins")
            .withIndex("by_user_and_thread", (q) => q.eq("userId", userId).eq("threadId", threadId as Id<"threads">))
            .order("desc")
            .take(200);

        return pins;
    });

export const createPin = authMutation
    .use(rateLimit("pins/create"))
    .input({
        imageIndex: v.optional(v.number().int().min(0).max(MAX_PINNED_IMAGE_INDEX)),
        // The image's key (host and path, no signature), matched against the message's images when the pin is shown; never
        // signed or served.
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
