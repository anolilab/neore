/**
 * Copying a message that carries an embedding reads its vector row once: the probe that finds the
 * `embeddings_*` table already holds the row, so a second read is a wasted round trip.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { cloneMessageBatch } from "./messages";

const OWNER = "owner-user";

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("cloneMessageBatch vector copy", () => {
    it("reads the source vector row once and copies it", async () => {
        expect.assertions(2);

        const { copies, reads } = await harness.run(async (ctx) => {
            const embeddingId = await ctx.db.insert("embeddings_768", {
                model: "m",
                table: "messages",
                userId: OWNER,
                vector: Array.from({ length: 768 }, (_, index) => index / 768),
            });
            const source = await ctx.db.insert("threads", { status: "active", title: "S", userId: OWNER });
            const target = await ctx.db.insert("threads", { status: "active", title: "T", userId: OWNER });

            await ctx.db.insert("messages", {
                embeddingId,
                message: { content: "hello", role: "user" },
                order: 0,
                status: "success",
                stepOrder: 0,
                threadId: source,
                tool: false,
                userId: OWNER,
            });

            const get = vi.spyOn(ctx.db, "get");

            await ctx.runMutation(cloneMessageBatch, {
                paginationOpts: { cursor: null, numItems: 10 },
                sourceThreadId: source,
                statuses: ["success"],
                targetThreadId: target,
            });

            const rows = await ctx.db.query("embeddings_768").collect();

            return {
                copies: rows.length,
                reads: get.mock.calls.filter(([table, id]) => String(table).startsWith("embeddings_") && id === embeddingId).length,
            };
        });

        expect(copies).toBe(2);
        expect(reads).toBe(1);
    });
});
