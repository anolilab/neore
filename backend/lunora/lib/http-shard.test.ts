/**
 * `onThreadShard`: `/chat/edit` and `/chat/media` run on the shard of the
 * thread their body names — the owner's, for a thread shared with the caller.
 */
import type { HttpActionCtx } from "lunorash/server";
import { describe, expect, it, vi } from "vitest";

import { callOnShard } from "./cross-shard";
import { currentShard } from "./shard-context";
import { inSystemShard, onRoutedShard, systemShardContext } from "./http-shard";
import { onThreadShard } from "./http-shard";

vi.mock("./cross-shard", () => {
    return { callOnShard: vi.fn(async () => "result") };
});

vi.mock("../_generated/internal", () => {
    return {
        internal: {
            agent: { sharing: { getGrantOwner: { __lunoraRef: "agent_sharing:getGrantOwner" } } },
            lib: {
                shard_housekeeping: { recordShardActivity: { __lunoraRef: "lib_shard_housekeeping:recordShardActivity" } },
                shard_routes: { getRouteOwner: { __lunoraRef: "lib_shard_routes:getRouteOwner" } },
            },
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

describe("system shard context", () => {
    const ref = { __lunoraRef: "x:y" };

    it("aims every runner at the shard key as the system, never through forShard", async () => {
        const { context } = contextFor(null);
        const forShard = vi.fn();
        const system = systemShardContext({ ...context, forShard } as unknown as HttpActionCtx, "user-9");

        await system.runQuery(ref as never, { a: 1 } as never);
        await system.runMutation(ref as never, {} as never);
        await system.runAction(ref as never, {} as never);

        expect(callOnShard).toHaveBeenCalledWith(ref, { a: 1 }, { shardKey: "user-9" });
        expect(vi.mocked(callOnShard)).toHaveBeenCalledTimes(3);
        expect(forShard).not.toHaveBeenCalled();
        expect(system.forShard).toBe(forShard);
    });

    it("runs the handler inside that shard's ALS context", async () => {
        const { context } = contextFor(null);
        let seen: string | undefined;

        await inSystemShard(context, "user-9", async () => {
            seen = currentShard();

            return null;
        });

        expect(seen).toBe("user-9");
    });

    it("routes a webhook to the owner in shardRoutes as the system, and to root for an unknown key", async () => {
        const { context } = contextFor(null);
        const rootQuery = vi.fn(async () => "owner-1");
        const handler = vi.fn(async (shardCtx: HttpActionCtx) => {
            await shardCtx.runQuery({ __lunoraRef: "h:h" } as never, {} as never);

            return currentShard();
        });

        await expect(onRoutedShard({ ...context, runQuery: rootQuery } as unknown as HttpActionCtx, "messenger", "c1", handler)).resolves.toBe("owner-1");
        expect(callOnShard).toHaveBeenLastCalledWith({ __lunoraRef: "h:h" }, {}, { shardKey: "owner-1" });

        rootQuery.mockResolvedValueOnce(null as never);
        await expect(onRoutedShard({ ...context, runQuery: rootQuery } as unknown as HttpActionCtx, "messenger", "c2", handler)).resolves.toBeUndefined();
    });
});
