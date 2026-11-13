import { environmentManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createQueryClient } from "./query-client";
import { THREAD_QUERY_GC_TIME_MS } from "./thread-queries";

const gcTimeOf = (queryKey: readonly unknown[]): number | undefined => createQueryClient().defaultQueryOptions({ queryKey }).gcTime;

describe(createQueryClient, () => {
    // The tests run in node, which TanStack takes for a server; the browser is the app's client.
    beforeEach(() => {
        environmentManager.setIsServer(() => false);
    });

    afterEach(() => {
        environmentManager.setIsServer(() => typeof window === "undefined");
    });

    it("keeps thread and message reads for the thread gcTime", () => {
        expect(gcTimeOf(["lunora", "chat_functions:getThread", '{"threadId":"t1"}', null])).toBe(THREAD_QUERY_GC_TIME_MS);
        expect(gcTimeOf(["lunora", "chat_functions:getThreadUIMessages", '{"threadId":"t1"}', "shard-1"])).toBe(THREAD_QUERY_GC_TIME_MS);
        expect(gcTimeOf(["lunora", "chat_composite:getThreadListData", "{}", null])).toBe(THREAD_QUERY_GC_TIME_MS);
    });

    it("leaves every other read on the default gcTime", () => {
        expect(gcTimeOf(["lunora", "tasks_functions:getTaskBoard", "{}", null])).toBeUndefined();
        expect(gcTimeOf(["session"])).toBeUndefined();
    });

    it("leaves a server render's thread reads on TanStack's server gcTime, which starts no timer", () => {
        environmentManager.setIsServer(() => true);

        expect(gcTimeOf(["lunora", "chat_functions:getThread", '{"threadId":"t1"}', null])).toBeUndefined();
        expect(gcTimeOf(["lunora", "chat_composite:getThreadListData", "{}", null])).toBeUndefined();
    });
});
