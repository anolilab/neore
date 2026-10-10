/**
 * Worker-side shard routing (docs/plans/per-user-sharding.md): where a request
 * that names no shard lands, and who `authorizeShard` lets onto a user's shard.
 */
import { describe, expect, it, vi } from "vitest";

import { createGrantLookup, createShardAuthorizer, GRANT_CACHE_TTL_MS, isShardRoutedRequest, withCallerShard } from "./shard-routing";

const ORIGIN = "http://localhost:8788";

const rpc = (body: unknown, path = "/_lunora/rpc"): Request =>
    new Request(`${ORIGIN}${path}`, { body: JSON.stringify(body), headers: { authorization: "Bearer t", "content-type": "application/json" }, method: "POST" });

describe("withCallerShard", () => {
    it("sends an RPC that names no shard to the caller's", async () => {
        const routed = await withCallerShard(rpc({ args: { a: 1 }, functionPath: "x:y" }), "user-a");

        expect(await routed.json()).toStrictEqual({ args: { a: 1 }, functionPath: "x:y", shardKey: "user-a" });
        expect(routed.headers.get("authorization")).toBe("Bearer t");
    });

    it("keeps a shard the caller named — a shared thread's owner", async () => {
        const request = rpc({ args: {}, functionPath: "x:y", shardKey: "owner-b" });

        expect(await withCallerShard(request, "user-a")).toBe(request);
    });

    it("leaves a fan-out alone", async () => {
        const request = rpc({ args: {}, fanOut: { table: "t" }, functionPath: "x:y" });

        expect(await withCallerShard(request, "user-a")).toBe(request);
    });

    it("routes each batch entry that names no shard", async () => {
        const routed = await withCallerShard(
            rpc(
                {
                    calls: [
                        { args: {}, functionPath: "a:b", id: 0 },
                        { args: {}, functionPath: "a:c", id: 1, shardKey: "owner-b" },
                    ],
                },
                "/_lunora/rpc-batch",
            ),
            "user-a",
        );

        expect(((await routed.json()) as { calls: { shardKey: string }[] }).calls.map((call) => call.shardKey)).toStrictEqual(["user-a", "owner-b"]);
    });

    it("adds the caller's shard to a live-query socket, unless one is named", async () => {
        const upgrade = new Request(`${ORIGIN}/_lunora/ws?token=abc`, { headers: { upgrade: "websocket" } });
        const routed = await withCallerShard(upgrade, "user-a");
        const url = new URL(routed.url);

        expect(url.searchParams.get("shard")).toBe("user-a");
        expect(url.searchParams.get("token")).toBe("abc");
        expect(routed.headers.get("upgrade")).toBe("websocket");

        const named = new Request(`${ORIGIN}/_lunora/ws?shard=owner-b`, { headers: { upgrade: "websocket" } });

        expect(await withCallerShard(named, "user-a")).toBe(named);
    });

    it("leaves an anonymous caller, other paths and malformed bodies on the default shard", async () => {
        const anonymous = rpc({ args: {}, functionPath: "x:y" });
        const other = new Request(`${ORIGIN}/chat/start`, { body: "{}", method: "POST" });
        const garbage = new Request(`${ORIGIN}/_lunora/rpc`, { body: "not json", method: "POST" });

        expect(await withCallerShard(anonymous, undefined)).toBe(anonymous);
        expect(await withCallerShard(other, "user-a")).toBe(other);
        expect(await withCallerShard(garbage, "user-a")).toBe(garbage);
        expect(isShardRoutedRequest(other)).toBe(false);
    });
});

describe("createShardAuthorizer", () => {
    const grants = new Set(["grantee:owner"]);
    const authorize = createShardAuthorizer(async (callerId, ownerId) => grants.has(`${callerId}:${ownerId}`));

    it("admits anyone to __root__", async () => {
        await expect(authorize({ identity: null, shardKey: "__root__" })).resolves.toBe(true);
    });

    it("admits a user to their own shard only", async () => {
        await expect(authorize({ identity: { userId: "user-a" }, shardKey: "user-a" })).resolves.toBe(true);
        await expect(authorize({ identity: { userId: "user-a" }, shardKey: "user-b" })).resolves.toBe(false);
    });

    it("admits a grantee to the owner's shard", async () => {
        await expect(authorize({ identity: { userId: "grantee" }, shardKey: "owner" })).resolves.toBe(true);
        await expect(authorize({ identity: { userId: "grantee" }, shardKey: "stranger" })).resolves.toBe(false);
    });

    it("refuses an anonymous caller any user shard", async () => {
        await expect(authorize({ identity: null, shardKey: "owner" })).resolves.toBe(false);
        await expect(authorize({ identity: {}, shardKey: "owner" })).resolves.toBe(false);
    });
});

describe("createGrantLookup", () => {
    const database = (rows: { first: unknown }[]) => {
        const statements: string[] = [];
        let call = 0;

        return {
            prepare: vi.fn((sql: string) => {
                statements.push(sql);

                return {
                    bind: () => {
                        return {
                            first: async () => {
                                const next = rows[call] ?? { first: null };

                                call += 1;

                                if (next.first instanceof Error) {
                                    throw next.first;
                                }

                                return next.first;
                            },
                        };
                    },
                };
            }),
            statements,
        };
    };

    it("finds a thread grant, then a page grant", async () => {
        const threadHit = database([{ first: { granted: 1 } }]);

        await expect(createGrantLookup(threadHit as never)("grantee", "owner")).resolves.toBe(true);
        expect(threadHit.statements[0]).toContain(`FROM "threadAccess"`);

        const pageHit = database([{ first: null }, { first: { granted: 1 } }]);

        await expect(createGrantLookup(pageHit as never)("grantee", "owner")).resolves.toBe(true);
        expect(pageHit.statements[1]).toContain(`FROM "pageAccess"`);
    });

    it("reads a table that does not exist yet as no grant", async () => {
        const missing = database([{ first: new Error("no such table: threadAccess") }, { first: new Error("no such table: pageAccess") }]);

        await expect(createGrantLookup(missing as never)("grantee", "owner")).resolves.toBe(false);
    });

    it("caches an answer, negative included, for the TTL", async () => {
        let now = 1000;
        const empty = database([]);
        const lookup = createGrantLookup(empty as never, () => now);

        await lookup("grantee", "owner");
        await lookup("grantee", "owner");

        expect(empty.prepare).toHaveBeenCalledTimes(2);

        now += GRANT_CACHE_TTL_MS + 1;
        await lookup("grantee", "owner");

        expect(empty.prepare).toHaveBeenCalledTimes(4);
    });
});
