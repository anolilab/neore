import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { retryFailedPage, withoutFailedPages } from "./failed-pages";

type Page = { hasMore: boolean; n: number; status: "ok" } | { status: "rate_limited" };

const data = (pages: Page[]) => {
    return { pageParams: pages.map((_, index) => index + 1), pages };
};

describe("withoutFailedPages", () => {
    it("drops the failed page at the end and its parameter, and keeps the rest in order", () => {
        const kept = withoutFailedPages(data([{ hasMore: true, n: 1, status: "ok" }, { hasMore: true, n: 2, status: "ok" }, { status: "rate_limited" }]));

        expect(kept.pages.map((page) => page.status)).toEqual(["ok", "ok"]);
        expect(kept.pageParams).toEqual([1, 2]);
    });

    it("leaves a list with no failure alone, and an empty one empty", () => {
        const whole = data([{ hasMore: false, n: 1, status: "ok" }]);

        expect(withoutFailedPages(whole)).toEqual(whole);
        expect(withoutFailedPages(data([]))).toEqual(data([]));
    });

    it("leaves nothing when the first page is the one that failed", () => {
        expect(withoutFailedPages(data([{ status: "rate_limited" }]))).toEqual(data([]));
    });
});

/** A query of the shape the files list has: a page that says whether more follow, read through a real observer. */
const filesQuery = (answers: Record<number, () => Promise<Page>>) => {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
    const asked: number[] = [];
    const answerFor = async (page: number): Promise<Page> => {
        asked.push(page);

        return await (
            answers[page] ??
            (async () => {
                return { status: "rate_limited" as const };
            })
        )();
    };
    const observer = new InfiniteQueryObserver<Page, Error, { pageParams: number[]; pages: Page[] }, ReadonlyArray<string>, number>(client, {
        getNextPageParam: (last) => (last.status === "ok" && last.hasMore ? last.n + 1 : undefined),
        initialPageParam: 1,
        queryFn: async ({ pageParam }) => await answerFor(pageParam),
        queryKey: ["files"],
    });
    const stop = observer.subscribe(() => undefined);

    return { asked, client, observer, stop };
};

const ok = (n: number, hasMore: boolean) => async (): Promise<Page> => {
    return { hasMore, n, status: "ok" };
};

describe("retryFailedPage", () => {
    it("asks again for the page that failed and for none of the pages already read", async () => {
        let attempt = 0;
        const { asked, client, observer, stop } = filesQuery({
            1: ok(1, true),
            2: async () => {
                attempt += 1;

                return attempt === 1 ? { status: "rate_limited" } : { hasMore: true, n: 2, status: "ok" };
            },
            3: ok(3, false),
        });

        await observer.refetch();
        await observer.fetchNextPage();
        expect(observer.getCurrentResult().data?.pages.map((page) => page.status)).toEqual(["ok", "rate_limited"]);
        expect(asked).toEqual([1, 2]);

        await retryFailedPage(client, ["files"], async () => await observer.fetchNextPage());

        expect(asked).toEqual([1, 2, 2]);
        expect(observer.getCurrentResult().data?.pages.map((page) => page.status)).toEqual(["ok", "ok"]);
        expect(observer.getCurrentResult().hasNextPage).toBe(true);

        // The pages after it load the way they do on first open.
        await observer.fetchNextPage();
        expect(asked).toEqual([1, 2, 2, 3]);
        expect(observer.getCurrentResult().hasNextPage).toBe(false);
        stop();
    });

    it("asks again for the page of a request that threw, and keeps the pages read", async () => {
        let attempt = 0;
        const { asked, client, observer, stop } = filesQuery({
            1: ok(1, true),
            2: async () => {
                attempt += 1;

                if (attempt === 1) {
                    throw new Error("offline");
                }

                return { hasMore: false, n: 2, status: "ok" };
            },
        });

        await observer.refetch();
        await observer.fetchNextPage();
        expect(observer.getCurrentResult().isError).toBe(true);
        expect(observer.getCurrentResult().data?.pages).toHaveLength(1);

        await retryFailedPage(client, ["files"], async () => await observer.fetchNextPage());

        expect(asked).toEqual([1, 2, 2]);
        expect(observer.getCurrentResult().data?.pages.map((page) => page.status)).toEqual(["ok", "ok"]);
        stop();
    });

    it("reads the first page again when the first page is the one that failed", async () => {
        let attempt = 0;
        const { asked, client, observer, stop } = filesQuery({
            1: async () => {
                attempt += 1;

                return attempt === 1 ? { status: "rate_limited" } : { hasMore: false, n: 1, status: "ok" };
            },
        });

        await observer.refetch();
        expect(observer.getCurrentResult().data?.pages.map((page) => page.status)).toEqual(["rate_limited"]);

        await retryFailedPage(client, ["files"], async () => await observer.fetchNextPage());

        expect(asked).toEqual([1, 1]);
        expect(observer.getCurrentResult().data?.pages.map((page) => page.status)).toEqual(["ok"]);
        stop();
    });
});
