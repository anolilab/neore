/**
 * Feedback leaves with the account (rows and their images) and travels with the
 * export: the user's own only, and past one batch (130 > 100, and not a
 * multiple of it, so "one page" cannot pass for "everything").
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FEEDBACK_READ_BYTES } from "../gdpr/read-budget";
import { deleteUserIntegrations } from "../gdpr/steps/residual-deletion-steps";
import schema from "../schema";
import { collectAllFeedback, collectFeedbackForExport } from "./gdpr";

const deletedKeys = vi.hoisted(() => [] as string[]);

vi.mock("../lib/storage-cleanup", async (importOriginal) => {
    return {
        ...(await importOriginal<object>()),
        scheduleObjectDeletion: async (_ctx: unknown, keys: string[]) => {
            deletedKeys.push(...keys);
        },
    };
});

type Harness = ReturnType<typeof lunoraTest>;

const A = "user-a";
const B = "user-b";
const MANY = 130;

let harness: Harness;

const seed = async (userId: string, count: number): Promise<void> => {
    await harness.run(async (ctx: any) => {
        for (let index = 0; index < count; index += 1) {
            await ctx.db.insert("feedback", {
                createdAt: index,
                images: [{ contentType: "image/png", key: `feedback/${userId}/${String(index)}`, size: 10 }],
                kind: "idea",
                message: `${userId} ${String(index)}`,
                userId,
            });
        }
    });
};

const countFor = async (userId: string): Promise<number> =>
    await harness.run(async (ctx: any) => {
        const { page } = await ctx.db.feedback.findMany({ where: { userId } });

        return page.length;
    });

beforeEach(() => {
    deletedKeys.length = 0;
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("feedback in GDPR flows", () => {
    it("deletes every feedback row of the user and its images, and nobody else's", async () => {
        await seed(A, MANY);
        await seed(B, 1);

        let rounds = 0;

        for (; rounds < 20; rounds += 1) {
            const { hasMore } = await harness.run(async (ctx: any) => await ctx.runMutation(deleteUserIntegrations, { userId: A }));

            if (!hasMore) {
                break;
            }
        }

        expect(await countFor(A)).toBe(0);
        expect(await countFor(B)).toBe(1);
        expect(new Set(deletedKeys).size).toBe(MANY);
        expect(deletedKeys.every((key) => key.startsWith(`feedback/${A}/`))).toBe(true);
    });

    it("exports every row of the user, oldest first, without the storage keys, and counts the whole rows it read", async () => {
        await seed(A, MANY);
        await seed(B, 1);

        const storedBytes = await harness.run(async (ctx: any) => {
            const { page } = await ctx.db.feedback.findMany({ where: { userId: A } });

            return page.reduce((total: number, row: unknown) => total + new TextEncoder().encode(JSON.stringify(row)).byteLength, 0);
        });
        const { readBytes, section: exported } = await collectAllFeedback(
            async (cursor) => await harness.run(async (ctx: any) => await ctx.runQuery(collectFeedbackForExport, { cursor, userId: A })),
            FEEDBACK_READ_BYTES,
        );

        expect(exported.truncated).toBe(false);
        expect(exported.feedback).toHaveLength(MANY);
        expect(exported.feedback[0]).toMatchObject({ createdAt: 0, images: [{ contentType: "image/png", size: 10 }], kind: "idea" });
        expect(JSON.stringify(exported)).not.toContain(B);
        expect(JSON.stringify(exported)).not.toContain("feedback/");
        expect(readBytes).toBe(storedBytes);
    });
});

describe("feedback in the export file", () => {
    it("stops past its read cap and marks the feedback as cut", async () => {
        await seed(A, MANY);

        const { readBytes, section } = await collectAllFeedback(
            async (cursor) => await harness.run(async (ctx: any) => await ctx.runQuery(collectFeedbackForExport, { cursor, userId: A })),
            1,
        );

        expect(section.truncated).toBe(true);
        expect(section.feedback.length).toBeLessThan(MANY);
        expect(readBytes).toBeGreaterThan(0);
    });

    it("reads nothing once the earlier sections used the action's budget, and marks the feedback as cut", async () => {
        const readPage = vi.fn(async () => {
            return { feedback: [{}], readBytes: 2 };
        });

        const { readBytes, section } = await collectAllFeedback(readPage, 0);

        expect(readPage).not.toHaveBeenCalled();
        expect(readBytes).toBe(0);
        expect(section).toStrictEqual({ feedback: [], truncated: true });
    });

    // Read from source: the export action needs storage and a workflow to run.
    it("is written into the export and counted before the trigger history", () => {
        const source = readFileSync(join(import.meta.dirname, "../gdpr/steps.ts"), "utf8");

        expect(source).toContain("feedback: feedback.section");
        expect(source).toContain("feedbackReadBudget(earlierReadBytes + repositories.readBytes)");
        expect(source).toContain("triggerReadBudget(earlierReadBytes + repositories.readBytes + feedback.readBytes)");
    });
});
