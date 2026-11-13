import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { isListedThread } from "./use-thread-shard";

vi.mock("@/lib/lunora/crpc", () => {
    return { useCRPC: vi.fn() };
});

const listKey = ["lunora", "chat_composite:getThreadListData", '{"paginationOpts":{"cursor":null,"numItems":50}}', null];

const cachedList = (data: unknown): QueryClient => {
    const queryClient = new QueryClient();

    queryClient.setQueryData(listKey, data);

    return queryClient;
};

describe(isListedThread, () => {
    it("finds a thread in the cached list's threads", () => {
        expect(isListedThread(cachedList({ threads: { page: [{ _id: "t1" }] } }), "t1")).toBe(true);
    });

    it("finds a temporary chat, which the list keeps apart from the threads", () => {
        expect(isListedThread(cachedList({ temporaryThreads: { page: [{ _id: "temp" }] }, threads: { page: [{ _id: "t1" }] } }), "temp")).toBe(true);
    });

    it("does not find a thread the list does not hold", () => {
        expect(isListedThread(cachedList({ threads: { page: [{ _id: "t1" }] } }), "shared")).toBe(false);
        expect(isListedThread(new QueryClient(), "t1")).toBe(false);
    });
});
