/**
 * An id carries no table of its own: `db.normalizeId` answers for ANY table, so the
 * `embeddings_*` table holding a vector row can only be found by reading them.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../../schema";
import { deleteVectorRow } from "../table-writes";
import { findVectorTable } from "./tables";

let harness: ReturnType<typeof lunoraTest>;

const run = <T>(body: (ctx: any) => Promise<T>): Promise<T> => harness.run(body as never);

const vector = (length: number) => {
    return { model: "m", table: "memories", userId: "u", vector: Array.from({ length }, (_, index) => index / length) };
};

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("findVectorTable", () => {
    it("names the dimension table that holds the row, not the first one", async () => {
        expect.assertions(3);

        const found = await run(async (ctx) => {
            const small = await ctx.db.insert("embeddings_768", vector(768));
            const large = await ctx.db.insert("embeddings_1536", vector(1536));
            const thread = await ctx.db.insert("threads", { status: "active", title: "T", userId: "u" });

            return [await findVectorTable(ctx.db, small), await findVectorTable(ctx.db, large), await findVectorTable(ctx.db, thread)];
        });

        expect(found[0]).toBe("embeddings_768");
        expect(found[1]).toBe("embeddings_1536");
        expect(found[2]).toBeNull();
    });
});

describe("deleteVectorRow", () => {
    it("deletes a row of any dimension and ignores one that is already gone", async () => {
        expect.assertions(3);

        const [first, second, gone] = await run(async (ctx) => {
            const id = await ctx.db.insert("embeddings_1536", vector(1536));

            await deleteVectorRow(ctx.db, id);

            const after = await ctx.db.get("embeddings_1536", id);

            await deleteVectorRow(ctx.db, id);

            return [id, after, await ctx.db.get("embeddings_1536", id)];
        });

        expect(first).toBeTruthy();
        expect(second).toBeNull();
        expect(gone).toBeNull();
    });
});
