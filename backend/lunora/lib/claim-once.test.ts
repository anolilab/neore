/**
 * `idempotencyClaims` is the one claim-once table: messenger event ids, trigger
 * webhook deliveries and queue jobs. Pins first-claim-wins, TTL expiry, leases
 * (provisional until completed, re-claimable once lapsed), release and purge.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import {
    claimKey,
    claimKeyFenced,
    claimOnce,
    completeKey,
    holdClaim,
    holdKey,
    holdTtlFrom,
    purgeExpiredClaims,
    reapLapsedClaims,
    releaseKey,
} from "./claim-once";

const NOW = 1_800_000_000_000;
const TTL = 60_000;

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
    vi.useRealTimers();
});

const mutate = async (reference: unknown, args: Record<string, unknown>): Promise<any> =>
    await harness.run(async (ctx: any) => await ctx.runMutation(reference, args));

const claim = async (key: string, extra: Record<string, unknown> = {}): Promise<boolean> => await mutate(claimKey, { key, scope: "s", ttlMs: TTL, ...extra });

const rows = async (): Promise<{ key: string; leaseExpiresAt?: number; userId?: string }[]> =>
    await harness.run(async (ctx: any) => await ctx.db.query("idempotencyClaims").collect());

describe("claimOnce", () => {
    it("lets the first claim of a key win and refuses every later one", async () => {
        await expect(claim("a")).resolves.toBe(true);
        await expect(claim("a")).resolves.toBe(false);
        await expect(claim("b")).resolves.toBe(true);
    });

    it("scopes keys", async () => {
        await expect(claim("a")).resolves.toBe(true);
        await expect(mutate(claimKey, { key: "a", scope: "other", ttlMs: TTL })).resolves.toBe(true);
    });

    it("is callable inside a transaction and tags the owner", async () => {
        await expect(harness.run(async (ctx: any) => await claimOnce(ctx, "s", "k", TTL, "user-a"))).resolves.toBe(true);
        expect(await rows()).toStrictEqual([expect.objectContaining({ key: "k", userId: "user-a" })]);
    });

    it("treats an expired claim as absent even before the purge ran", async () => {
        await claim("a");
        vi.setSystemTime(NOW + TTL + 1);

        await expect(claim("a")).resolves.toBe(true);
        expect(await rows()).toHaveLength(1);
    });
});

describe("leases", () => {
    const lapse = { args: JSON.stringify({ threadId: "t1" }), target: "chat_media_abandon:failAbandonedMediaJob" };

    it("never make the work re-claimable, lapsed or not", async () => {
        await expect(claim("job", { leaseMs: 1000, onLapse: lapse })).resolves.toBe(true);
        await expect(claim("job", { leaseMs: 1000 })).resolves.toBe(false);

        vi.setSystemTime(NOW + 1001);

        await expect(claim("job", { leaseMs: 1000 })).resolves.toBe(false);
    });

    it("run the lapse handler once when the deadline passes uncompleted", async () => {
        await claim("job", { leaseMs: 1000, onLapse: lapse });
        await claim("done", { leaseMs: 1000, onLapse: lapse });
        await claim("plain");
        await mutate(completeKey, { key: "done", scope: "s" });

        // Before the deadline: nothing to reap.
        await expect(mutate(reapLapsedClaims, {})).resolves.toBe(0);

        vi.setSystemTime(NOW + 1001);

        const scheduled = await harness.run(async (ctx: any) => {
            const calls: unknown[] = [];

            ctx.scheduler.runAfter = async (_delay: number, target: unknown, args: unknown) => {
                calls.push({ args, target });
            };

            const reaped = await ctx.runMutation(reapLapsedClaims, {});

            return { calls, reaped };
        });

        expect(scheduled.reaped).toBe(1);
        expect(scheduled.calls).toStrictEqual([{ args: { claimKey: "job", threadId: "t1" }, target: "chat_media_abandon:failAbandonedMediaJob" }]);
        // Cleared, so it runs once; the claim itself stays.
        await expect(mutate(reapLapsedClaims, {})).resolves.toBe(0);
        const remaining = await rows();

        expect(remaining.find((row) => row.key === "job")?.leaseExpiresAt).toBeUndefined();
    });

    it("are cleared by completion, so a finished job is never reaped", async () => {
        await claim("job", { leaseMs: 1000, onLapse: lapse });
        await mutate(completeKey, { key: "job", scope: "s" });

        const [row] = await rows();

        expect(row?.leaseExpiresAt).toBeUndefined();
    });
});

describe("releaseKey", () => {
    it("gives a claim back so a retry of the same key is accepted", async () => {
        await claim("a");
        await mutate(releaseKey, { key: "a", scope: "s" });

        await expect(claim("a")).resolves.toBe(true);
    });
});

describe("releaseKey with a fence", () => {
    it("answers the claimedAt of the claim it took, or null while the key is held", async () => {
        const first = await mutate(claimKeyFenced, { key: "a", scope: "s", ttlMs: TTL });

        expect(first).toBe(NOW);
        await expect(mutate(claimKeyFenced, { key: "a", scope: "s", ttlMs: TTL })).resolves.toBeNull();
    });

    it("deletes only the claim its claimedAt names, so a newer claim on the key survives", async () => {
        const first = await mutate(claimKeyFenced, { key: "a", scope: "s", ttlMs: TTL });

        vi.setSystemTime(NOW + TTL + 1);
        const second = await mutate(claimKeyFenced, { key: "a", scope: "s", ttlMs: TTL });

        await mutate(releaseKey, { claimedAt: first, key: "a", scope: "s" });
        await expect(claim("a")).resolves.toBe(false);

        await mutate(releaseKey, { claimedAt: second, key: "a", scope: "s" });
        await expect(claim("a")).resolves.toBe(true);
    });
});

describe("claimKeyFenced with unlessHeld", () => {
    const other = { key: "legacy", scope: "old" };

    it("is refused while the other claim is held, taking nothing, and accepted once it lapsed", async () => {
        await mutate(claimKey, { ...other, ttlMs: TTL });
        await expect(mutate(claimKeyFenced, { key: "a", scope: "s", ttlMs: TTL, unlessHeld: other })).resolves.toBeNull();
        expect(await rows()).toHaveLength(1);

        vi.setSystemTime(NOW + TTL + 1);
        await expect(mutate(claimKeyFenced, { key: "a", scope: "s", ttlMs: TTL, unlessHeld: other })).resolves.toBe(NOW + TTL + 1);
    });

    it("takes the claim when the other is absent", async () => {
        await expect(mutate(claimKeyFenced, { key: "a", scope: "s", ttlMs: TTL, unlessHeld: other })).resolves.toBe(NOW);
    });
});

describe("holdClaim", () => {
    const hold = async (claimedAt: number, ttlMs: number, key = "a"): Promise<boolean> =>
        await harness.run(async (ctx: any) => await holdClaim(ctx, "s", key, claimedAt, ttlMs, "u"));
    const expiries = async (): Promise<number[]> => {
        const found: { expiresAt: number }[] = await harness.run(async (ctx: any) => await ctx.db.query("idempotencyClaims").collect());

        return found.map((row) => row.expiresAt);
    };

    it("lengthens the claim its claimedAt names, and never shortens it", async () => {
        const claimedAt = await mutate(claimKeyFenced, { key: "a", scope: "s", ttlMs: TTL });

        await expect(hold(claimedAt, 10 * TTL)).resolves.toBe(true);
        expect(await expiries()).toEqual([NOW + 10 * TTL]);
        await expect(hold(claimedAt, 1)).resolves.toBe(true);
        expect(await expiries()).toEqual([NOW + 10 * TTL]);
    });

    it("takes a lapsed claim again under the same claimedAt when nobody took the key", async () => {
        const claimedAt = await mutate(claimKeyFenced, { key: "a", scope: "s", ttlMs: TTL });

        vi.setSystemTime(NOW + TTL + 1);
        await expect(hold(claimedAt, 10 * TTL)).resolves.toBe(true);
        expect(await harness.run(async (ctx: any) => await ctx.db.query("idempotencyClaims").collect())).toEqual([
            expect.objectContaining({ claimedAt, expiresAt: NOW + 10 * TTL }),
        ]);
    });

    it("takes the key again, tagged with the owner, once the lapsed row was purged", async () => {
        const claimedAt = await mutate(claimKeyFenced, { key: "a", scope: "s", ttlMs: TTL });

        vi.setSystemTime(NOW + TTL + 1);
        await mutate(purgeExpiredClaims, {});
        await expect(hold(claimedAt, 10 * TTL)).resolves.toBe(true);
        expect(await harness.run(async (ctx: any) => await ctx.db.query("idempotencyClaims").collect())).toEqual([
            expect.objectContaining({ claimedAt, expiresAt: NOW + 10 * TTL, userId: "u" }),
        ]);
    });

    it("refuses, changing nothing, when another claim holds the key", async () => {
        const claimedAt = await mutate(claimKeyFenced, { key: "a", scope: "s", ttlMs: TTL });

        vi.setSystemTime(NOW + TTL + 1);

        const other = await mutate(claimKeyFenced, { key: "a", scope: "s", ttlMs: TTL });

        await expect(hold(claimedAt, 10 * TTL)).resolves.toBe(false);
        expect(await harness.run(async (ctx: any) => await ctx.db.query("idempotencyClaims").collect())).toEqual([
            expect.objectContaining({ claimedAt: other, expiresAt: NOW + TTL + 1 + TTL }),
        ]);
    });
});

describe("purgeExpiredClaims", () => {
    it("drops only claims past their expiry", async () => {
        await claim("old");
        vi.setSystemTime(NOW + TTL + 1);
        await claim("fresh");

        await expect(mutate(purgeExpiredClaims, {})).resolves.toBe(1);
        const remaining = await rows();

        expect(remaining.map((row) => row.key)).toStrictEqual(["fresh"]);
    });
});

describe("holdKey", () => {
    // What a run calls when it is admitted: its own fenced claim is stretched, and a key another request took is left to it.
    it("stretches the claim its claimedAt names, and refuses a fence that is not the key's claim", async () => {
        const claimedAt = (await mutate(claimKeyFenced, { key: "t", scope: "rt", ttlMs: TTL })) as number;

        await expect(mutate(holdKey, { claimedAt, key: "t", scope: "rt", ttlMs: TTL * 10 })).resolves.toBe(true);
        vi.setSystemTime(NOW + TTL * 5);
        await expect(claim("t", { scope: "rt" })).resolves.toBe(false);

        await expect(mutate(holdKey, { claimedAt: claimedAt + 1, key: "t", scope: "rt", ttlMs: TTL })).resolves.toBe(false);
    });
});

describe("holdTtlFrom", () => {
    it("holds a late-starting run's claim for a full run from its start, not from the request", async () => {
        const claimedAt = (await mutate(claimKeyFenced, { key: "run", scope: "rt", ttlMs: TTL })) as number;

        // The request's short claim lapsed long before the job started.
        vi.setSystemTime(NOW + TTL * 20);
        await expect(mutate(holdKey, { claimedAt, key: "run", scope: "rt", ttlMs: holdTtlFrom(claimedAt, TTL * 10) })).resolves.toBe(true);

        // Still inside a full run from the start: another request is refused.
        vi.setSystemTime(NOW + TTL * 25);
        await expect(claim("run", { scope: "rt" })).resolves.toBe(false);
    });

    it("lapses inside the run when counted from the request instead, which is why the start is used", async () => {
        const claimedAt = (await mutate(claimKeyFenced, { key: "late", scope: "rt", ttlMs: TTL })) as number;

        vi.setSystemTime(NOW + TTL * 20);
        await expect(mutate(holdKey, { claimedAt, key: "late", scope: "rt", ttlMs: TTL * 10 })).resolves.toBe(true);

        // The hold ended at the request's clock (ten minutes from the request), so a second request takes the key mid-run.
        vi.setSystemTime(NOW + TTL * 25);
        await expect(claim("late", { scope: "rt" })).resolves.toBe(true);
    });
});
