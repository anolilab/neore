/**
 * The expired-export sweep is terminal: an export it has handled leaves the
 * `by_expires` index, so a second run finds nothing and writes no second audit
 * row. It used to re-select every expired export on every run, forever.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { cleanupExpiredExports } from "./request-sweeps";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
    vi.useRealTimers();
});

const sweep = async (): Promise<void> => {
    await harness.run(async (ctx: any) => await ctx.runMutation(cleanupExpiredExports, {}));
};

const exportRow = {
    expiresAt: NOW - DAY,
    requestedAt: NOW - 2 * DAY,
    requestType: "export" as const,
    status: "completed" as const,
    userEmail: "someone@example.com",
    userId: "user-a",
};

describe("cleanupExpiredExports", () => {
    it("handles an expired export once and writes one audit row across repeated runs", async () => {
        await harness.run(async (ctx: any) => await ctx.db.insert("gdprRequests", exportRow));

        await sweep();
        await sweep();
        await sweep();

        const audit = await harness.run(async (ctx: any) => await ctx.db.query("gdprAuditLog").collect());
        const [request] = await harness.run(async (ctx: any) => await ctx.db.query("gdprRequests").collect());

        expect(audit.filter((row: { action: string }) => row.action === "export_expired")).toHaveLength(1);
        expect(request.expiresAt).toBeUndefined();
        expect(request.errorMessage).toBe("Export expired and has been deleted");
    });

    it("leaves an export that has not expired alone", async () => {
        await harness.run(async (ctx: any) => await ctx.db.insert("gdprRequests", { ...exportRow, expiresAt: NOW + DAY }));

        await sweep();

        const audit = await harness.run(async (ctx: any) => await ctx.db.query("gdprAuditLog").collect());

        expect(audit).toHaveLength(0);
    });
});
