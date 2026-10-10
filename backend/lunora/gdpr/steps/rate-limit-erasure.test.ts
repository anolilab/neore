/**
 * `minimiseGdprRecords` erases the user's rate-limit windows by walking the
 * `by_key` index a page at a time. The walk must reach every page: a window of
 * the deleted user on a later page is erased, and a neighbour's window is kept.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { schemaWithShardedTables } from "../../lib/test-schema";
import { minimiseGdprRecords, RATE_LIMIT_PAGE } from "./residual-deletion-steps";

type Harness = ReturnType<typeof lunoraTest>;

const A = "user-a";
const B = "user-b";

let harness: Harness;

beforeEach(() => {
    // `projects` is `.global()`; the harness has no D1 backend (see lib/test-schema.ts).
    harness = lunoraTest(schemaWithShardedTables(["projects"]) as never);
});

afterEach(() => {
    harness.close();
});

describe("minimiseGdprRecords rate-limit walk", () => {
    it("erases the user's windows across every page and keeps the other users'", async () => {
        // Two full pages plus a partial one, with the user's windows spread across all of them.
        const total = RATE_LIMIT_PAGE * 2 + 37;
        const ownKeys = Math.ceil(total / 3);

        await harness.run(async (ctx: any) => {
            for (let index = 0; index < total; index += 1) {
                const owned = index % 3 === 0;

                await ctx.db.insert("rateLimits", {
                    key: owned ? `neore:chat/x:${A}:${String(index)}` : `neore:chat/x:${B}:${String(index)}`,
                    ts: 1,
                    value: 1,
                });
            }
        });

        await harness.run(async (ctx: any) => await ctx.runMutation(minimiseGdprRecords, { userId: A }));

        const left = (await harness.run(async (ctx: any) => await ctx.db.query("rateLimits").collect())) as { key: string }[];

        expect(left).toHaveLength(total - ownKeys);
        expect(left.some((row) => row.key.includes(A))).toBe(false);
        expect(left.every((row) => row.key.includes(B))).toBe(true);
    });
});
