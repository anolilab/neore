import { LunoraError, v } from "lunorash/server";

import type { Id } from "../../_generated/dataModel";
import { authMutation, authQuery, rateLimit } from "../../lib/crpc";
import { MAX_LENGTH } from "../../lib/validators";

export const getThreadPins = authQuery
    .input({
        threadId: v.id("threads"),
    })
    .output(
        v.array(
            v.object({
                _creationTime: v.number(),
                _id: v.string(),
                createdAt: v.number(),
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
    .query(async ({ args: { threadId }, ctx: context }) => {
        const { userId } = context.user;

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
        messageId: v.string().max(MAX_LENGTH.id),
        messageRole: v.string().max(MAX_LENGTH.short),
        selectedText: v.optional(v.string().max(MAX_LENGTH.document)),
        threadId: v.id("threads"),
    })
    .output(v.string())
    .mutation(async ({ args: { messageId, messageRole, selectedText, threadId }, ctx: context }) => {
        const { userId } = context.user;
        const now = context.now;
        const pinId = await context.db.insert("threadPins", {
            createdAt: now,
            messageId,
            messageRole,
            selectedText,
            threadId: threadId as Id<"threads">,
            updatedAt: now,
            userId,
        });

        context.log.event("chat.create_pin", { hasSelectedText: selectedText !== undefined, messageRole });

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
        const pin = await context.db.get(pinId as Id<"threadPins">);

        if (!pin) {
            throw new LunoraError("NOT_FOUND", "Pin not found");
        }

        if (pin.userId !== userId) {
            throw new LunoraError("FORBIDDEN", "Cannot update another user's pin");
        }

        await context.db.patch(pinId as Id<"threadPins">, {
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
        const pin = await context.db.get(pinId as Id<"threadPins">);

        if (!pin) {
            throw new LunoraError("NOT_FOUND", "Pin not found");
        }

        if (pin.userId !== userId) {
            throw new LunoraError("FORBIDDEN", "Cannot update another user's pin");
        }

        await context.db.patch(pinId as Id<"threadPins">, {
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
        const pin = await context.db.get(pinId as Id<"threadPins">);

        if (!pin) {
            throw new LunoraError("NOT_FOUND", "Pin not found");
        }

        if (pin.userId !== userId) {
            throw new LunoraError("FORBIDDEN", "Cannot delete another user's pin");
        }

        await context.db.delete(pinId as Id<"threadPins">);
        context.log.event("chat.delete_pin", { deleted: true });
    });
