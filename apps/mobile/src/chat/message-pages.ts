/** Messages in a history page: the newest page on open, and each page "Load older messages" adds. */
export const HISTORY_PAGE_SIZE = 100;

/** One page of a thread's messages: the server lists its pages newest first, and each page is oldest first inside. */
export interface MessagePage<M> {
    continueCursor: string | null;
    isDone: boolean;
    page: M[];
}

/** Reads one page of a thread's messages, from the newest page when the cursor is null. */
export type MessagePageFetch<M> = (cursor: string | null, pageSize: number) => Promise<MessagePage<M>>;

/**
 * What a chat shows when it opens or re-reads: the newest page only, in one request. The rest of the history is
 * fetched a page at a time by "Load older messages", from the cursor returned here (null once there is no more).
 */
export const readNewestRows = async <M, R>(fetchPage: MessagePageFetch<M>, toRow: (message: M) => R): Promise<{ olderCursor: string | null; rows: R[] }> => {
    // eslint-disable-next-line unicorn/no-null -- the query takes null for its first page
    const page = await fetchPage(null, HISTORY_PAGE_SIZE);

    // eslint-disable-next-line unicorn/no-null -- null is "no older page" on the screen
    return { olderCursor: page.isDone ? null : page.continueCursor, rows: page.page.map((message) => toRow(message)) };
};
