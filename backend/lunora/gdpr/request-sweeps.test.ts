/**
 * The expired-export sweep is terminal: an export it has handled leaves the
 * `by_expires` index, so a second run finds nothing and writes no second audit
 * row. It used to re-select every expired export on every run, forever.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { scheduleObjectDeletion } from "../lib/storage-cleanup";
import { cleanupExpiredExports } from "./request-sweeps";

vi.mock("../lib/storage-cleanup", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/storage-cleanup")>()),
        scheduleObjectDeletion: vi.fn(),
    };
});

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    vi.mocked(scheduleObjectDeletion).mockReset();
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

    it("keeps the stored file reference when its deletion cannot be scheduled, and completes on a later run", async () => {
        await harness.run(async (ctx: any) => await ctx.db.insert("gdprRequests", { ...exportRow, storageId: "exports/user-a.zip" }));

        vi.mocked(scheduleObjectDeletion).mockRejectedValueOnce(new Error("scheduler unavailable"));

        await sweep();

        const [failed] = await harness.run(async (ctx: any) => await ctx.db.query("gdprRequests").collect());
        const auditAfterFailure = await harness.run(async (ctx: any) => await ctx.db.query("gdprAuditLog").collect());

        // The file is still referenced, so the next run can still delete it.
        expect(failed.storageId).toBe("exports/user-a.zip");
        expect(failed.expiresAt).toBeDefined();
        expect(auditAfterFailure).toHaveLength(0);

        await sweep();

        const [done] = await harness.run(async (ctx: any) => await ctx.db.query("gdprRequests").collect());
        const auditAfterRetry = await harness.run(async (ctx: any) => await ctx.db.query("gdprAuditLog").collect());

        expect(done.expiresAt).toBeUndefined();
        expect(auditAfterRetry.filter((row: { action: string }) => row.action === "export_expired")).toHaveLength(1);
    });

    it("still handles healthy exports when more than a batch of rows keep failing", async () => {
        const failing = 150;
        const healthy = 5;

        // The failing rows expired first, so they fill the front of `by_expires`.
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < failing; index += 1) {
                await ctx.db.insert("gdprRequests", { ...exportRow, expiresAt: NOW - 3 * DAY + index, storageId: `bad/${index}.zip` });
            }

            for (let index = 0; index < healthy; index += 1) {
                await ctx.db.insert("gdprRequests", { ...exportRow, expiresAt: NOW - DAY + index, storageId: `good/${index}.zip` });
            }
        });

        vi.mocked(scheduleObjectDeletion).mockImplementation(async (_context, keys) => {
            if (String(keys[0]).startsWith("bad/")) {
                throw new Error("scheduler unavailable");
            }
        });

        await sweep();
        await sweep();

        const rows: any[] = await harness.run(async (ctx: any) => await ctx.db.query("gdprRequests").collect());
        const audit = await harness.run(async (ctx: any) => await ctx.db.query("gdprAuditLog").collect());
        const stuck = rows.filter((row) => String(row.storageId).startsWith("bad/"));

        expect(rows.filter((row) => row.expiresAt === undefined)).toHaveLength(healthy);
        expect(audit.filter((row: { action: string }) => row.action === "export_expired")).toHaveLength(healthy);
        // The failing rows are untouched: file reference and expiry both kept.
        expect(stuck).toHaveLength(failing);
        expect(stuck.every((row) => row.expiresAt !== undefined)).toBe(true);
    });

    it("stops at the batch size mid-page, even after a failing row on the first page", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("gdprRequests", { ...exportRow, expiresAt: NOW - 3 * DAY, storageId: "bad/0.zip" });

            for (let index = 0; index < 250; index += 1) {
                await ctx.db.insert("gdprRequests", { ...exportRow, expiresAt: NOW - DAY + index, storageId: `good/${index}.zip` });
            }
        });

        vi.mocked(scheduleObjectDeletion).mockImplementation(async (_context, keys) => {
            if (String(keys[0]).startsWith("bad/")) {
                throw new Error("scheduler unavailable");
            }
        });

        await sweep();

        const rows: any[] = await harness.run(async (ctx: any) => await ctx.db.query("gdprRequests").collect());
        const audit = await harness.run(async (ctx: any) => await ctx.db.query("gdprAuditLog").collect());

        expect(rows.filter((row) => row.expiresAt === undefined)).toHaveLength(100);
        expect(audit.filter((row: { action: string }) => row.action === "export_expired")).toHaveLength(100);
    });
});
