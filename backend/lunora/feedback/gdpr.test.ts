/**
 * Feedback leaves with the account (rows and their images) and travels with the
 * export: the user's own only, and past one batch (130 > 100, and not a
 * multiple of it, so "one page" cannot pass for "everything").
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deleteUserIntegrations } from "../gdpr/steps/residual-deletion-steps";
import schema from "../schema";
import { collectAllFeedback, collectFeedbackForExport } from "./gdpr";

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
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("feedback in GDPR flows", () => {
    it("deletes every feedback row of the user and nobody else's", async () => {
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
    });

    it("exports every row of the user, oldest first, without the storage keys", async () => {
        await seed(A, MANY);
        await seed(B, 1);

        const exported = await collectAllFeedback(
            async (cursor) => await harness.run(async (ctx: any) => await ctx.runQuery(collectFeedbackForExport, { cursor, userId: A })),
        );

        expect(exported.truncated).toBe(false);
        expect(exported.feedback).toHaveLength(MANY);
        expect(exported.feedback[0]).toMatchObject({ createdAt: 0, images: [{ contentType: "image/png", size: 10 }], kind: "idea" });
        expect(JSON.stringify(exported)).not.toContain(B);
        expect(JSON.stringify(exported)).not.toContain("feedback/");
    });
});
