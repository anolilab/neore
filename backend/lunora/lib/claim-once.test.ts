/**
 * `idempotencyClaims` is the one claim-once table: messenger event ids, trigger
 * webhook deliveries and queue jobs. Pins first-claim-wins, TTL expiry, leases
 * (provisional until completed, re-claimable once lapsed), release and purge.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { claimKey, claimOnce, completeKey, purgeExpiredClaims, reapLapsedClaims, releaseKey } from "./claim-once";

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
