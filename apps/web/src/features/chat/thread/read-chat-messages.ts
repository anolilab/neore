import type { Id } from "@neore/backend/dataModel";

/** The server returns at most 20 messages a page; five pages reach the last 100, which `buildChatTranscript` then trims to fit. */
const PAGE_SIZE = 20;
const MAX_PAGES = 5;

interface ReadMessage {
    order: number;
    role: string;
    stepOrder: number;
    text: string;
}

interface ChatPageArgs {
    paginationOpts: { cursor: null | string; numItems: number };
    threadId: Id<"threads">;
}

interface ChatPage {
    continueCursor: null | string;
    isDone: boolean;
    page: ReadMessage[];
}

/**
 * A chat's newest messages, oldest first. `fetchPage` is the thread view's own query, passed in: the same owner / grant /
 * lock checks as opening the chat, and the unlock proof and shard routing the cRPC factory adds. A locked chat without its
 * proof throws. Nothing is read through another path.
 */
export const readChatMessages = async (fetchPage: (args: ChatPageArgs) => Promise<ChatPage>, threadId: string): Promise<ReadMessage[]> => {
    const messages: ReadMessage[] = [];
    let cursor: null | string = null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await fetchPage({ paginationOpts: { cursor, numItems: PAGE_SIZE }, threadId: threadId as Id<"threads"> });

        messages.push(...result.page);

        if (result.isDone) {
            break;
        }

        cursor = result.continueCursor;
    }

    return messages.toSorted((a, b) => a.order - b.order || a.stepOrder - b.stepOrder);
};
