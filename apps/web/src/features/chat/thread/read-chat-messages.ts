import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";

import type { useLunora } from "@/lib/lunora/crpc";

/** The server returns at most 20 messages a page; five pages reach the last 100, which `buildChatTranscript` then trims to fit. */
const PAGE_SIZE = 20;
const MAX_PAGES = 5;

interface ReadMessage {
    order: number;
    role: string;
    stepOrder: number;
    text: string;
}

/**
 * A chat's newest messages, oldest first, read through the thread view's own
 * query: the same owner / grant / lock checks as opening the chat, and a locked
 * chat without its unlock proof throws. Nothing is read through another path.
 */
export const readChatMessages = async (lunora: ReturnType<typeof useLunora>, threadId: string): Promise<ReadMessage[]> => {
    const messages: ReadMessage[] = [];
    let cursor: null | string = null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
        const result: { continueCursor: null | string; isDone: boolean; page: ReadMessage[] } = await lunora.query(api.chat.functions.getThreadUIMessages, {
            paginationOpts: { cursor, numItems: PAGE_SIZE },
            threadId: threadId as Id<"threads">,
        });

        messages.push(...result.page);

        if (result.isDone) {
            break;
        }

        cursor = result.continueCursor;
    }

    return messages.toSorted((a, b) => a.order - b.order || a.stepOrder - b.stepOrder);
};
