import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { QueryRead } from "./newest-read";
import { readPastRecovery, useGrantRevision, useNewestRead } from "./newest-read";

interface Answer {
    now: number;
    status: string;
}

interface Reads {
    fresh: QueryRead<Answer>;
    live: QueryRead<Answer>;
}

const none: QueryRead<Answer> = { data: undefined, dataUpdatedAt: 0, errorUpdatedAt: 0, isError: false };

const answered = (data: Answer, at: number): QueryRead<Answer> => {
    return { data, dataUpdatedAt: at, errorUpdatedAt: 0, isError: false };
};

describe(useNewestRead, () => {
    it("stays failed when an answer older on the server's clock arrives after the failure", () => {
        const pushed = { now: 10, status: "open" };
        const initialProps: Reads = { fresh: { data: undefined, dataUpdatedAt: 0, errorUpdatedAt: 0, isError: false }, live: answered(pushed, 100) };
        const { rerender, result } = renderHook(({ fresh, live }: Reads) => useNewestRead(live, fresh, ["status", "thread-1"]), { initialProps });

        expect(result.current).toMatchObject({ data: pushed, failed: false });

        // The subscription fails, keeping its last push; then a read sent before that push arrives.
        const failedLive = { ...answered(pushed, 100), errorUpdatedAt: 200, isError: true };

        rerender({ fresh: answered({ now: 5, status: "open" }, 300), live: failedLive });

        expect(result.current).toMatchObject({ data: pushed, failed: true });

        // A read newer on the server's clock clears it.
        const later = { now: 20, status: "open" };

        rerender({ fresh: answered(later, 400), live: failedLive });

        expect(result.current).toMatchObject({ data: later, failed: false });
    });

    it("counts a failure in the same millisecond as the answer it follows: the page is not left showing", () => {
        const pushed = { now: 10, status: "open" };
        const initialProps: Reads = { fresh: answered(pushed, 100), live: none };
        const { rerender, result } = renderHook(({ fresh, live }: Reads) => useNewestRead(live, fresh, ["status", "thread-1"]), { initialProps });

        expect(result.current).toMatchObject({ data: pushed, failed: false });

        // The subscription fails within the millisecond the status answer came in.
        rerender({ fresh: answered(pushed, 100), live: { ...none, errorUpdatedAt: 100, isError: true } });

        expect(result.current).toMatchObject({ data: pushed, failed: true });
    });

    it("stays failed when the live read recovers by answering its last push again, until a newer answer comes", () => {
        const pushed = { now: 10, status: "open" };
        const initialProps: Reads = { fresh: none, live: answered(pushed, 100) };
        const { rerender, result } = renderHook(({ fresh, live }: Reads) => useNewestRead(live, fresh, ["status", "thread-1"]), { initialProps });

        rerender({ fresh: none, live: { ...answered(pushed, 100), errorUpdatedAt: 200, isError: true } });

        expect(result.current).toMatchObject({ data: pushed, failed: true });

        // The subscription recovers and hands back the same push, later.
        rerender({ fresh: none, live: { ...answered(pushed, 300), errorUpdatedAt: 200 } });

        expect(result.current).toMatchObject({ data: pushed, failed: true });

        const later = { now: 20, status: "open" };

        rerender({ fresh: none, live: { ...answered(later, 400), errorUpdatedAt: 200 } });

        expect(result.current).toMatchObject({ data: later, failed: false });
    });

    it("holds nothing of another query's reads: a switch to another chat drops the last chat's failure", () => {
        const pushed = { now: 10, status: "open" };
        const initialProps = { key: "thread-1", live: { ...answered(pushed, 100), errorUpdatedAt: 200, isError: true } };
        const { rerender, result } = renderHook(({ key, live }: { key: string; live: QueryRead<Answer> }) => useNewestRead(live, none, ["status", key]), {
            initialProps,
        });

        expect(result.current).toMatchObject({ failed: true });

        // The other chat's cached answer is older than the last chat's failure, and its own read never failed.
        const other = { now: 8, status: "open" };

        rerender({ key: "thread-2", live: answered(other, 50) });

        expect(result.current).toMatchObject({ data: other, failed: false });
    });

    it("keeps a browser that opened while a one-shot read finding none was out, when that read arrives after the push", () => {
        // A status read is sent; a browser opens and the subscription pushes it; then the read, older on the server's clock, arrives.
        const opened = { now: 20, status: "running" };
        const { rerender, result } = renderHook(({ fresh, live }: Reads) => useNewestRead(live, fresh, ["status", "thread-1"]), {
            initialProps: { fresh: none, live: answered(opened, 200) },
        });

        rerender({ fresh: answered({ now: 10, status: "none" }, 300), live: answered(opened, 200) });

        expect(result.current).toMatchObject({ data: opened, failed: false });
    });

    it.each([
        ["the denial is the live push and the affirmative read arrives later", "live"],
        ["the denial is the read past the subscription and arrives first", "fresh"],
    ])("keeps a denial on an equal server time when %s, until a strictly later answer", (_case, deniedOn) => {
        const isDenied = (answer: Answer): boolean => answer.status === "denied";
        const denial = { now: 10, status: "denied" };
        const running = { now: 10, status: "running" };
        const [live, fresh] = deniedOn === "live" ? [answered(denial, 100), answered(running, 200)] : [answered(running, 200), answered(denial, 100)];
        const { rerender, result } = renderHook(({ fresh: f, live: l }: Reads) => useNewestRead(l, f, ["status", "thread-1"], isDenied), {
            initialProps: { fresh: none, live: deniedOn === "live" ? live : none },
        });

        rerender({ fresh, live });

        expect(result.current.data).toStrictEqual(denial);

        const later = { now: 11, status: "running" };

        rerender({ fresh: answered(later, 300), live });

        expect(result.current.data).toStrictEqual(later);
    });
});

describe(useGrantRevision, () => {
    it("keeps the highest revision of the chat, and starts afresh once the cache holds no answer (another account signed in)", () => {
        const { rerender, result } = renderHook(
            ({ answers }: { answers: ({ revision?: number } | undefined)[] }) => useGrantRevision(["status", "thread-1"], answers),
            { initialProps: { answers: [{ revision: 5 }] as ({ revision?: number } | undefined)[] } },
        );

        rerender({ answers: [{ revision: 2 }] });
        expect(result.current).toBe(5);

        rerender({ answers: [undefined] });
        rerender({ answers: [{ revision: 1 }] });
        expect(result.current).toBe(1);
    });
});

describe(readPastRecovery, () => {
    it("shares one read among the cards that recover together, and reads no more when it fails", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const read = vi.fn<() => Promise<unknown>>().mockRejectedValue(new Error("network"));
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const queryKey = ["status", "fresh"];
        // As a card's one-shot read: not enabled, read only on request.
        const observer = new QueryObserver(client, { enabled: false, queryFn: read, queryKey });

        // Two cards of the chat recover at the same moment.
        readPastRecovery(client, queryKey, observer);
        readPastRecovery(client, queryKey, observer);

        await vi.waitFor(() => {
            expect(client.getQueryState(queryKey)?.status).toBe("error");
        });
        // A read once more would start as the failure settles: a task later, none is out.
        await vi.advanceTimersByTimeAsync(0);
        expect(client.getQueryState(queryKey)?.fetchStatus).toBe("idle");
        expect(read).toHaveBeenCalledTimes(1);
    });
});
