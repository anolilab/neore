import z from "zod/v4";

import type { Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/internal";
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { servesUser } from "../../lib/shard-context";
import type { RememberResult, RememberStatus } from "../../memory/remember";
import toonEncodeOutput from "./toon-encode";

/** What the model is told for each outcome, so it never reports a save that did not happen. */
const NOTES: Record<RememberStatus, string> = {
    already_known: "Already in memory: it was confirmed, nothing new was saved.",
    already_requested: "This message was already handled by an earlier call; nothing more was saved.",
    memory_off: "Nothing was saved: the user has memory turned off. They can turn it on in Settings → Personalization.",
    not_private: "Nothing was saved: facts are remembered only in a chat that is the user's alone (not shared, temporary, locked or run by an agent).",
    not_your_words: "Nothing was saved: only a message the user just typed in this chat can be remembered, not a regenerated, forwarded or attached one.",
    nothing_asked: "No fact the user asked to remember was found in their message, or memory does not keep it; facts listed were learned from it as usual.",
    private_marker: "Nothing was saved: the user's message carries a privacy marker.",
    refused:
        "Nothing was saved: what was found was not backed by the user's own typed words, or held a secret or health information, which memory never keeps.",
    saved: "Saved to memory as listed: `asked` marks what the user asked to remember.",
    unavailable: "Nothing was saved: memory could not be reached. Tell the user it did not work.",
};

/**
 * Saves what the user explicitly asked to be remembered in the message they just sent. The model only triggers it: the
 * backend reads that message and words the fact itself (`memory/remember.ts`).
 */
const rememberTool = createTool<Record<string, never>, RememberResult, ToolContext>({
    description:
        "Save to the user's long-term memory what they explicitly ask you to remember in the message they just sent ('remember that…'). " +
        "Call it once per message, ONLY on such a request, never on your own initiative. It takes no input: what to save is read from " +
        "the user's own words in that message. Report the outcome to the user as the result states it.",
    execute: async (context) => {
        const promptMessageId = context.runTurn?.promptMessageId;

        // A run nobody is at, or one that recorded no turn, has no message the user just typed. The memories live on the
        // user's own shard, which a collaborator's turn on the owner's chat is not.
        if (context.headless === true || !context.userId || !context.threadId || !promptMessageId || !servesUser(context.userId)) {
            return { facts: [], status: "not_private" };
        }

        try {
            return await context.runAction(internal.memory.remember.rememberFact, {
                promptMessageId,
                replyKey: context.replyKey,
                threadId: context.threadId as Id<"threads">,
                userId: context.userId,
            });
        } catch (error) {
            console.warn("[remember] Save failed:", error);

            return { facts: [], status: "unavailable" };
        }
    },
    inputSchema: z.object({}),
    title: "Remember",
    toModelOutput: (_context, { output }) =>
        toonEncodeOutput({
            facts: output.facts,
            // A request stopped part-way: what is listed was written, nothing after it.
            note:
                output.stopped === undefined
                    ? NOTES[output.status]
                    : `${NOTES[output.status]} Then it stopped, and nothing more was saved: ${NOTES[output.stopped]}`,
            status: output.status,
        }),
});

export default rememberTool;
