import { afterEach, describe, expect, it } from "vitest";

import {
    isPageShardKnown,
    isThreadShardKnown,
    notePageShard,
    noteThreadShard,
    registerPageShard,
    registerStreamOfThread,
    registerThreadShard,
    resetShardRegistry,
    shardKeyForArgs,
    shardOptionsFor,
} from "./shard-routing";

describe("shard routing", () => {
    afterEach(() => {
        resetShardRegistry();
    });

    it("sends an unregistered object to the caller's own shard", () => {
        expect(shardKeyForArgs({ threadId: "t1" })).toBeUndefined();
        expect(shardOptionsFor({ pageId: "p1" })).toStrictEqual({});
        expect(shardKeyForArgs(undefined)).toBeUndefined();
    });

    it("sends a shared thread's calls to its owner's shard", () => {
        registerThreadShard("t1", "owner-a");

        expect(shardKeyForArgs({ threadId: "t1", other: 1 })).toBe("owner-a");
        expect(shardOptionsFor({ threadId: "t1" })).toStrictEqual({ shardKey: "owner-a" });
        expect(shardKeyForArgs({ threadId: "t2" })).toBeUndefined();
        // The vault names a thread `chatId`.
        expect(shardKeyForArgs({ chatId: "t1" })).toBe("owner-a");
    });

    it("sends a shared page's calls to its owner's shard", () => {
        registerPageShard("p1", "owner-b");

        expect(shardKeyForArgs({ pageId: "p1" })).toBe("owner-b");
    });

    it("routes a stream with its thread", () => {
        registerThreadShard("t1", "owner-a");
        registerStreamOfThread("s1", "t1");
        registerStreamOfThread("s2", "own-thread");

        expect(shardKeyForArgs({ streamId: "s1" })).toBe("owner-a");
        expect(shardKeyForArgs({ streamId: "s2" })).toBeUndefined();
    });

    it("settles an own object with no owner, and a shared one with its owner", () => {
        expect(isThreadShardKnown("t-own")).toBe(false);

        noteThreadShard("t-own", null);
        noteThreadShard("t-shared", "owner-a");
        notePageShard("p-shared", "owner-b");

        expect(isThreadShardKnown("t-own")).toBe(true);
        expect(shardKeyForArgs({ threadId: "t-own" })).toBeUndefined();
        expect(shardKeyForArgs({ threadId: "t-shared" })).toBe("owner-a");
        expect(isPageShardKnown("p-shared")).toBe(true);
        expect(shardKeyForArgs({ pageId: "p-shared" })).toBe("owner-b");
    });

    it("forgets every owner on reset", () => {
        registerThreadShard("t1", "owner-a");
        resetShardRegistry();

        expect(shardKeyForArgs({ threadId: "t1" })).toBeUndefined();
    });
});
