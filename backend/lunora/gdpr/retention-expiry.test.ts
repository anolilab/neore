/**
 * When a shard's oldest retained rows expire, which the shard's census wake-up is set to (`retentionExpiryOf`). Checked against the same
 * cutoffs the prune uses, so a row is kept just before its expiry and pruned at it.
 */
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import schema from "../schema";
import { NO_RETENTION_DUE, setRetentionDue } from "../lib/shard-housekeeping";
import { retentionDueAfterPrune, retentionExpiryOf, USAGE_DAILY_RETENTION_DAYS, usageDailyCutoffDate } from "./retention";

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = USAGE_DAILY_RETENTION_DAYS * DAY_MS;

describe("retentionExpiryOf", () => {
    it("has no expiry for a shard with no retained rows", () => {
        expect(retentionExpiryOf({})).toBeUndefined();
    });

    it("expires a ledger row at the first UTC midnight past its window, when the prune takes it", () => {
        const at = Date.UTC(2026, 0, 1, 15, 30);
        const expiry = retentionExpiryOf({ ledgerAt: at })!;

        expect(expiry).toBe(Date.UTC(2026, 0, 2) + WINDOW_MS);
        // `pruneOrganizationRepliesBefore` takes `at < now - window`.
        expect(at < expiry - WINDOW_MS).toBe(true);
    });

    it("gives every reply of one day the same expiry, so a busy day wakes its shard once", () => {
        const morning = retentionExpiryOf({ ledgerAt: Date.UTC(2026, 0, 1, 0, 0, 1) });
        const night = retentionExpiryOf({ ledgerAt: Date.UTC(2026, 0, 1, 23, 59, 59) });

        expect(morning).toBe(night);
    });

    it("keeps a day row until its date is before the cutoff, which is from the day after it plus the window", () => {
        const date = "2026-01-01";
        const expiry = retentionExpiryOf({ usageDate: date })!;

        expect(usageDailyCutoffDate(expiry - 1) <= date).toBe(true);
        expect(usageDailyCutoffDate(expiry) > date).toBe(true);
    });

    it("wakes for the earliest of its oldest rows", () => {
        const later = retentionExpiryOf({ ledgerAt: Date.UTC(2026, 5, 1) });
        const earlier = retentionExpiryOf({ ledgerAt: Date.UTC(2026, 0, 1) });

        expect(retentionExpiryOf({ ledgerAt: Date.UTC(2026, 5, 1), usageDate: "2026-01-01" })).toBe(
            Math.min(later!, retentionExpiryOf({ usageDate: "2026-01-01" })!),
        );
        expect(earlier! < later!).toBe(true);
    });
});

describe("retentionDueAfterPrune", () => {
    it("is due now when a full batch left a ledger row past its window, not at the midnight its expiry rounds to", () => {
        const now = Date.UTC(2027, 3, 10, 11);
        const ledgerAt = now - WINDOW_MS - 60 * 60 * 1000;

        expect(retentionDueAfterPrune(now, { ledgerAt })).toBe(now);
    });

    it("is the oldest row's expiry when nothing left has expired", () => {
        const now = Date.UTC(2027, 3, 10, 11);
        const ledgerAt = now - WINDOW_MS + 60 * 60 * 1000;

        expect(retentionDueAfterPrune(now, { ledgerAt })).toBe(retentionExpiryOf({ ledgerAt }));
        expect(retentionDueAfterPrune(now, {})).toBeUndefined();
    });
});

describe("setRetentionDue", () => {
    it("clears the shard's retained-rows time when it holds none, so a later tick does not prune for nothing", async () => {
        const harness = lunoraTest(schema as never);

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("shardActivity", { lastActiveAt: 0, retentionDueAt: 5, shardKey: "s1" });
        });
        await harness.run(async (ctx: any) => await setRetentionDue(ctx, undefined, "s1"));

        const row = await harness.run(async (ctx: any) => await ctx.db.shardActivity.findFirst({ where: { shardKey: "s1" } }));

        expect(row?.retentionDueAt).toBe(NO_RETENTION_DUE);
        harness.close();
    });
});
