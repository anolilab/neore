import type { ModelMessage } from "ai";

import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { addMessagesHandler } from "../../agent/messages";
import { serializeMessage } from "../../agent/mapping";
import { vMessageWithMetadata } from "../../agent/validators";
import { parse } from "../../lib/validators";

/**
 * A user's prompt, saved in the CALLER's transaction: the row `agent.saveMessage` writes, without its nested
 * `addMessages` mutation, which would commit on its own. `/chat/start` saves through this, so the thread, the prompt and
 * the send's claim (`chat/start-claim.ts`) commit together or not at all.
 */
export const savePromptInTransaction = async (
    ctx: MutationCtx,
    {
        content,
        fileIds,
        fromUser,
        model,
        parentId,
        threadId,
    }: {
        /** AI SDK user content parts, as the HTTP action built them. */
        content: Extract<ModelMessage, { role: "user" }>["content"];
        fileIds?: string[];
        /** A person sent it into an existing thread (`threads.lastUserMessageAt`). */
        fromUser?: boolean;
        /** The agent name the agent client stamps: the run's model. */
        model: string;
        parentId?: string;
        threadId: string;
    },
): Promise<string> => {
    // Serialized as `saveMessages` does.
    const { fileIds: inlineFileIds, message } = await serializeMessage(ctx, { content, role: "user" });
    const allFileIds = [...(fileIds ?? []), ...(inlineFileIds ?? [])];
    const { messages } = await addMessagesHandler(ctx, {
        agentName: model,
        ...(fromUser === true && { fromUser: true }),
        messages: [parse(vMessageWithMetadata, { message, ...(allFileIds.length > 0 && { fileIds: allFileIds }) }) as never],
        ...(parentId !== undefined && { promptMessageId: parentId as Id<"messages"> }),
        threadId: threadId as Id<"threads">,
    });
    const saved = messages.at(-1);

    if (!saved) {
        throw new Error("The prompt was not saved");
    }

    return saved._id;
};
