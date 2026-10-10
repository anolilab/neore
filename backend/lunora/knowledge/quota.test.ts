/**
 * The knowledge-base quota and the per-document charge: a batch of 25 costs
 * 25 tokens, not one, and no add goes past the per-user file or byte ceiling.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRatelimit, rateLimitGuard } from "../lib/rate-limiter";
import schema from "../schema";
import { insertStoredDocuments } from "./documents";
import { KNOWLEDGE_QUOTA, knowledgeQuotaProblem } from "./quota";

const USER = "user-a";
const FILE_CAP = /at most/u;
const BYTE_CAP = /MB/u;
const FILES_3 = /at most 3 files/u;

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
    vi.useRealTimers();
});

const insert = async (count: number, size = 1) =>
    await harness.run(
        async (ctx: any) =>
            await ctx.runMutation(insertStoredDocuments, {
                documents: Array.from({ length: count }, (_, index) => {
                    return { mimeType: "text/plain", name: `d${String(index)}.txt`, size, storageKey: `knowledge/${USER}/${String(index)}` };
                }),
                tier: "free",
                userId: USER,
            }),
    );

describe(knowledgeQuotaProblem, () => {
    const quota = { maxBytes: 100, maxFiles: 3 };

    it("admits what fits and refuses the file or byte that does not", () => {
        expect(knowledgeQuotaProblem({ bytes: 0, files: 2 }, { bytes: 10, files: 1 }, quota)).toBeUndefined();
        expect(knowledgeQuotaProblem({ bytes: 0, files: 3 }, { bytes: 0, files: 1 }, quota)).toMatch(FILES_3);
        expect(knowledgeQuotaProblem({ bytes: 95, files: 0 }, { bytes: 10, files: 1 }, quota)).toMatch(BYTE_CAP);
    });
});

describe("insertStoredDocuments quota", () => {
    it("refuses a batch that would pass the file ceiling, inserting none of it", async () => {
        const { maxFiles } = KNOWLEDGE_QUOTA.free;

        await harness.run(async (ctx: any) => {
            for (let index = 0; index < maxFiles - 1; index += 1) {
                await ctx.db.insert("knowledgeFiles", { createdAt: 1, mimeType: "text/plain", name: "x", size: 1, status: "ready", userId: USER });
            }
        });

        await expect(insert(2)).rejects.toThrow(FILE_CAP);

        const count = await harness.run(async (ctx: any) => {
            const rows = await ctx.db.query("knowledgeFiles").collect();

            return rows.length;
        });

        expect(count).toBe(maxFiles - 1);
        await expect(insert(1)).resolves.toHaveLength(1);
    });

    it("refuses a batch that would pass the byte ceiling", async () => {
        await expect(insert(2, KNOWLEDGE_QUOTA.free.maxBytes / 2 + 1)).rejects.toThrow(BYTE_CAP);
    });
});

describe("per-document charge", () => {
    it("takes one knowledge/addDocument token per document", async () => {
        // A token bucket refills with the clock; frozen, the difference is exact.
        vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });

        const remaining = async () =>
            await harness.run(async (ctx: any) => {
                const { remaining: left } = await createRatelimit("knowledge/addDocument:free", ctx.db as never).getRemaining(USER);

                return left;
            });
        const before = await remaining();

        await harness.run(
            async (ctx: any) => await rateLimitGuard({ ...ctx, count: 25, rateLimitKey: "knowledge/addDocument", user: { plan: null, userId: USER } } as never),
        );

        expect(await remaining()).toBe(before - 25);
    });
});
