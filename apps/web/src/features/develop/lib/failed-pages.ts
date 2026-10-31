import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";

/** The pages that were read, without the failed one at the end: a page that failed ends the list, so none follows it. */
export const withoutFailedPages = <T extends { status: string }>(data: InfiniteData<T, number>): InfiniteData<T, number> => {
    let kept = data.pages.length;

    while (kept > 0 && data.pages[kept - 1]?.status !== "ok") {
        kept -= 1;
    }

    return { pageParams: data.pageParams.slice(0, kept), pages: data.pages.slice(0, kept) };
};

/**
 * Asks the host again for the page that failed, and only that one: the pages already read stay as they are, and the ones after
 * it load the way they do on first open. Nothing is read when no page is left (the first one failed): that page is read afresh.
 */
export const retryFailedPage = async <T extends { status: string }>(
    client: QueryClient,
    queryKey: QueryKey,
    fetchNextPage: () => Promise<unknown>,
): Promise<void> => {
    const data = client.getQueryData<InfiniteData<T, number>>(queryKey);
    const kept = data ? withoutFailedPages(data) : undefined;

    if (kept === undefined || kept.pages.length === 0) {
        await client.resetQueries({ queryKey });

        return;
    }

    client.setQueryData(queryKey, kept);
    await fetchNextPage();
};
