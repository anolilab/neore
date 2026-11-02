/** `updateBatch` patches the table that holds the row, and refuses a vector that does not fit it. */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { updateBatch } from "./index";
import type { VectorTableName } from "./tables";

const UNSUPPORTED = /Unsupported vector dimension 100/;
const MISMATCH = /does not fit embeddings_768/;

let harness: ReturnType<typeof lunoraTest>;

type Ctx = Parameters<Parameters<ReturnType<typeof lunoraTest>["run"]>[0]>[0];

const run = <T>(body: (ctx: Ctx) => Promise<T>): Promise<T> => harness.run(body);
const vector = (length: number, first = 0.5): number[] => Array.from({ length }, (_, index) => (index === 0 ? first : 0.5));
const update = (vectors: { id: Id<VectorTableName>; model: string; vector: number[] }[]) => run(async (ctx) => await ctx.runMutation(updateBatch, { vectors }));
const insert768 = () => run(async (ctx) => await ctx.db.insert("embeddings_768", { model: "old", table: "memories", userId: "u", vector: vector(768) }));

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("updateBatch", () => {
    it("patches the row in its own table", async () => {
        const id = await insert768();

        await update([{ id, model: "new", vector: vector(768, 0.25) }]);

        const row = await run(async (ctx) => await ctx.db.get("embeddings_768", id));

        expect(row).toMatchObject({ model: "new" });
        expect((row?.vector as number[])[0]).toBe(0.25);
    });

    it("rejects a vector whose length is not a supported dimension", async () => {
        const id = await insert768();

        await expect(update([{ id, model: "new", vector: vector(100) }])).rejects.toThrow(UNSUPPORTED);
    });

    it("rejects a vector of another supported dimension than the row's table", async () => {
        const id = await insert768();

        await expect(update([{ id, model: "new", vector: vector(1024) }])).rejects.toThrow(MISMATCH);
        expect(await run(async (ctx) => await ctx.db.get("embeddings_768", id))).toMatchObject({ model: "old" });
    });

    it("skips a row that is gone", async () => {
        const id = await insert768();

        await run(async (ctx) => await ctx.db.delete("embeddings_768", id));

        await expect(update([{ id, model: "new", vector: vector(768) }])).resolves.toBeNull();
    });
});
