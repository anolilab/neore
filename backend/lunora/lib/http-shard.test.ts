/**
 * `onThreadShard`: `/chat/edit` and `/chat/media` run on the shard of the
 * thread their body names — the owner's, for a thread shared with the caller.
 */
import type { HttpActionCtx } from "lunorash/server";
import { describe, expect, it, vi } from "vitest";

import { onThreadShard } from "./http-shard";

vi.mock("../_generated/internal", () => {
    return {
        internal: {
            agent: { sharing: { getGrantOwner: { __lunoraRef: "agent_sharing:getGrantOwner" } } },
            lib: { shard_housekeeping: { recordShardActivity: { __lunoraRef: "lib_shard_housekeeping:recordShardActivity" } } },
        },
    };
});

/** A context whose grant lookup answers `grants[threadId]`, recording each shard it is aimed at. */
const contextFor = (userId: string | null, grants: Record<string, string> = {}) => {
    const shards: string[] = [];
    const runners = (shardKey: string) => {
        shards.push(shardKey);

        return {
            runAction: vi.fn(),
            runMutation: vi.fn(async () => null),
            runQuery: vi.fn(async (_reference: unknown, args: { threadId: string }) => grants[args.threadId] ?? null),
        };
    };
    const context = { auth: { userId }, forShard: runners, ...runners("__root__") } as unknown as HttpActionCtx;

    shards.length = 0;

    return { context, shards };
};

const post = (body: unknown): Request => new Request("https://backend.test/chat/edit", { body: JSON.stringify(body), method: "POST" });

const handlerSeeing = () => {
    const seen: { body?: unknown } = {};
    const handler = vi.fn(async (_context: HttpActionCtx, request: Request) => {
        seen.body = await request.json();

        return new Response("ok");
    });

    return { handler, seen };
};

describe("onThreadShard", () => {
    it("runs on the owner's shard for a thread shared with the caller, and leaves the body readable", async () => {
        const { context, shards } = contextFor("viewer", { "thread-1": "owner" });
        const { handler, seen } = handlerSeeing();

        await onThreadShard(handler)(context, post({ messageId: "m1", threadId: "thread-1" }));

        expect(shards).toContain("owner");
        expect(seen.body).toStrictEqual({ messageId: "m1", threadId: "thread-1" });
    });

    it("runs on the caller's shard without a threadId", async () => {
        const { context, shards } = contextFor("viewer-2");
        const { handler } = handlerSeeing();

        await onThreadShard(handler)(context, post({ messageId: "m1" }));

        expect(shards.at(-1)).toBe("viewer-2");
        expect(shards).not.toContain("owner");
    });

    it("runs on the caller's shard for their own thread (no grant)", async () => {
        const { context, shards } = contextFor("viewer-3");
        const { handler } = handlerSeeing();

        await onThreadShard(handler)(context, post({ messageId: "m1", threadId: "own-thread" }));

        expect(shards.at(-1)).toBe("viewer-3");
    });

    it("runs an anonymous request unchanged", async () => {
        const { context, shards } = contextFor(null);
        const { handler } = handlerSeeing();

        await onThreadShard(handler)(context, post({ threadId: "thread-1" }));

        expect(shards).toStrictEqual([]);
        expect(handler).toHaveBeenCalledWith(context, expect.any(Request));
    });
});
