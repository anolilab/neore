import type { ModelMessage } from "ai";

import { assert } from "../../lib/error-helpers";
import type { MessageDoc } from "../validators";
import type { Message } from "../validators";
import type { VectorDimension } from "../vector/tables";
import { saveMessages } from "./messages";
import { embedMessages, getPromptArray } from "./search";
import type { ActionCtx as ActionContext, Config, MutationCtx as MutationContext } from "./types";

const saveInputMessages = async (
    context: MutationContext | ActionContext,
    // `component: AgentComponent` removed — see the note on `saveMessages`.
    {
        messages,
        prompt,
        threadId,
        userId,
        ...args
    }: Pick<Config, "usageHandler" | "embeddingModel" | "callSettings"> & {
        agentName?: string;
        messages: (ModelMessage | Message)[] | undefined;
        prompt: string | (ModelMessage | Message)[] | undefined;
        promptMessageId: string | undefined;
        storageOptions?: {
            saveMessages?: "all" | "promptAndOutput";
        };
        threadId: string;
        userId: string | undefined;
    },
): Promise<{
    pendingMessage: MessageDoc;
    promptMessageId: string | undefined;
    savedMessages: MessageDoc[];
}> => {
    const shouldSave = args.storageOptions?.saveMessages ?? "promptAndOutput";
    // If only a promptMessageId is provided, this will be empty.
    const promptArray = getPromptArray(prompt);

    const toSave: (ModelMessage | Message)[] = [];

    if (args.promptMessageId) {
        // We don't save any inputs if a promptMessageId is provided.
        // It's unclear where they'd want to save the new messages.
    } else if (shouldSave === "all") {
        if (messages) {
            toSave.push(...messages);
        }

        toSave.push(...promptArray);
    } else if (promptArray.length > 0) {
        // We treat the whole promptArray as the prompt message to save.
        toSave.push(...promptArray);
    } else if (messages) {
        // Otherwise, treat the last message as the prompt message to save.
        toSave.push(...messages.slice(-1));
    }

    let embeddings:
        | {
              dimension: VectorDimension;
              model: string;
              vectors: (number[] | null)[];
          }
        | undefined;

    if (args.embeddingModel && toSave.length > 0) {
        assert("runAction" in context, "You must be in an action context to generate embeddings");
        embeddings = await embedMessages(context, { ...args, threadId, userId: userId ?? undefined }, toSave);

        if (embeddings) {
            // for the pending message
            embeddings.vectors.push(null);
        }
    }

    const saved = await saveMessages(context, {
        embeddings,
        failPendingSteps: !!args.promptMessageId,
        messages: [...toSave, { content: [], role: "assistant" }],
        metadata: [
            ...Array.from({ length: toSave.length }, () => {
                return {};
            }),
            { status: "pending" },
        ],
        promptMessageId: args.promptMessageId,
        threadId,
        userId,
    });
    const pendingMessage = saved.messages.at(-1);

    if (!pendingMessage) {
        throw new Error("Expected at least one message to be saved");
    }

    const promptMessage = toSave.length > 0 ? saved.messages.at(-2) : undefined;

    return {
        pendingMessage,
        promptMessageId: promptMessage?._id ?? args.promptMessageId,
        savedMessages: saved.messages.slice(0, -1),
    };
};

export default saveInputMessages;
