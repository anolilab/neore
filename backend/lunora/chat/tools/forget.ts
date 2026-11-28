import z from "zod/v4";

import type { Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/internal";
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { servesUser } from "../../lib/shard-context";
import { FORGET_MAX_CANDIDATES, type ForgetCandidate, type ForgetResult, type ForgetStatus } from "../../memory/forget";
import toonEncodeOutput from "./toon-encode";

type ForgetInput = { memories?: ForgetCandidate[]; query?: string };

/** What the model is told for each outcome, so it never reports a deletion that did not happen. */
const NOTES: Record<ForgetStatus, string> = {
    deleted: "Deleted from memory as listed. Tell the user what was forgotten.",
    memory_off:
        "Nothing was deleted: the user has memory turned off, so it cannot be changed from chat. They can still delete memories in Settings → Personalization.",
    needs_confirmation:
        "Nothing was deleted yet. If it is clear which of these the user means, call forget again with `memories` set to those, id and text exactly as listed; the user is then asked to confirm. Otherwise ask the user which they mean first.",
    not_private:
        "Nothing was deleted: memories are changed from chat only in a chat that is the user's alone (not shared, temporary, locked or run by an agent). They can delete memories in Settings → Personalization.",
    not_your_request:
        "Nothing was deleted: only a request in the message the user just typed in this chat, the one that started this reply, can delete a memory. A request sent while you were replying is not read: ask them to send it as a new message.",
    nothing_found:
        "Nothing was deleted: no memory matching that was found. Tell the user nothing matched; they can review their memories in Settings → Personalization.",
    private_message:
        "Nothing was read or deleted: the user's message carries a privacy marker, which keeps memory out of it. Ask them to send the request again without the marker.",
    unavailable: "Nothing was deleted: memory could not be reached. Tell the user it did not work.",
};

/** Why the texts of what a confirm already deleted are withheld, by the refusal that came after the delete. */
const WITHHELD_BECAUSE: Partial<Record<ForgetStatus, string>> = {
    memory_off: "memory was turned off",
    not_private: "the chat is no longer the user's alone",
    not_your_request: "the request is no longer current",
    private_message: "the chat is no longer the user's alone",
    unavailable: "the chat's privacy could not be checked",
};

const noteOf = (output: ForgetResult): string => {
    // Deleted before the refusal: the status's own note would say nothing was deleted.
    const parts = [
        output.deletedCount === undefined
            ? NOTES[output.status]
            : `${output.deletedCount} confirmed memories were deleted as the user approved. No memory text is shown, because ${WITHHELD_BECAUSE[output.status] ?? "the request was refused"}.`,
    ];

    if (output.changed !== undefined && output.candidates === undefined) {
        parts.push(`${output.changed} of the confirmed memories changed since the user was asked and were not deleted.`);
    } else if (output.changed !== undefined) {
        parts.push(
            `${output.changed} of the confirmed memories changed since the user was asked (reworded or merged) and were not deleted: what memory holds now is listed under candidates. Show it to the user and ask again before deleting it.`,
        );
    }

    const merged = output.merged ?? 0;
    const gone = (output.gone ?? 0) - merged;

    if (merged > 0) {
        parts.push(
            `${merged} of the confirmed memories were merged into another memory that no longer matches what the user was shown, and were not deleted. Tell the user, and that they can ask again in their own words.`,
        );
    }

    if (gone > 0) {
        parts.push(`Of the confirmed memories, ${gone} no longer read as shown and were not deleted.`);
    }

    if (output.unchecked !== undefined) {
        parts.push(
            `${output.unchecked} of the confirmed memories changed since the user was asked and could not be checked right now, so they were not deleted. Ask the user to try again in a moment.`,
        );
    }

    return parts.join(" ");
};

/**
 * Deletes what the user explicitly asks to forget in the message that started the reply. A lookup only hands back
 * candidates; a call naming `memories` deletes those and always waits for the user's approval, in every permission mode
 * and under any allow (`needsApproval`, kept by `applyToolPermissions`).
 */
const forgetTool = createTool<ForgetInput, ForgetResult, ToolContext>({
    description:
        "Delete from the user's long-term memory what they explicitly ask you to forget in the message that started this reply ('forget that…'). " +
        "Call it ONLY on such a request, never on your own initiative. Pass `query`: a short statement of what to forget, such as 'User lives in Berlin'. " +
        "Matching memories come back; call it again with `memories` (id and text as listed) for the ones meant, and the user confirms before anything is deleted. A request sent while you were replying is not read: ask them to send it as a new message. Report the outcome as the result states it.",
    execute: async (context, input) => {
        const promptMessageId = context.runTurn?.promptMessageId;

        // A run nobody is at, or one that recorded no turn, has no request the user just typed. The memories live on the
        // user's own shard, which a collaborator's turn on the owner's chat is not.
        if (context.headless === true || !context.userId || !context.threadId || !promptMessageId || !servesUser(context.userId)) {
            return { deleted: [], status: "not_private" };
        }

        try {
            return await context.runAction(internal.memory.forget.forgetMemories, {
                ...(input.memories !== undefined && input.memories.length > 0 ? { memories: input.memories } : { query: input.query }),
                promptMessageId,
                replyKey: context.replyKey,
                threadId: context.threadId as Id<"threads">,
                userId: context.userId,
            });
        } catch (error) {
            console.warn("[forget] Forget failed:", error);

            return { deleted: [], status: "unavailable" };
        }
    },
    inputSchema: z
        .object({
            memories: z
                .array(z.object({ id: z.string().min(1).max(64), text: z.string().min(1).max(2000) }))
                .min(1)
                .max(FORGET_MAX_CANDIDATES)
                .optional()
                .meta({ description: "Memories to delete, id and text exactly as a previous forget call listed them. The user is asked to confirm." }),
            query: z.string().min(1).max(500).optional().meta({ description: "What the user asked to forget, as a short statement about them." }),
        })
        .refine((input) => (input.memories === undefined) !== (input.query === undefined), { error: "Pass either `query` or `memories`." }),
    // Deleting the memories named always asks the user, whatever the tool's mode.
    needsApproval: (_context, input) => (input.memories?.length ?? 0) > 0,
    title: "Forget",
    toModelOutput: (_context, { output }) =>
        toonEncodeOutput({
            ...(output.candidates !== undefined && { candidates: output.candidates }),
            deleted: output.deleted,
            note: noteOf(output),
            status: output.status,
        }),
});

export default forgetTool;
