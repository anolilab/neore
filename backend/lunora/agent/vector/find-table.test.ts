/**
 * An id carries no table of its own: `db.normalizeId` answers for ANY table, so the
 * `embeddings_*` table holding a vector row can only be found by reading them.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../../schema";
import { deleteVectorRow } from "../table-writes";
import { findVectorRow, findVectorTable } from "./tables";

let harness: ReturnType<typeof lunoraTest>;

type Ctx = Parameters<Parameters<ReturnType<typeof lunoraTest>["run"]>[0]>[0];

const run = <T>(body: (ctx: Ctx) => Promise<T>): Promise<T> => harness.run(body);

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

describe("findVectorRow", () => {
    it("returns the table with the row, probing 768 first, and null for an id in no table", async () => {
        expect.assertions(4);

        const { found, missing, probes } = await run(async (ctx) => {
            const id = await ctx.db.insert("embeddings_768", vector(768));
            const thread = await ctx.db.insert("threads", { status: "active", title: "T", userId: "u" });
            const get = vi.spyOn(ctx.db, "get");
            const row = await findVectorRow(ctx.db, id);
            const probed = get.mock.calls.length;

            return { found: row, missing: await findVectorRow(ctx.db, thread), probes: probed };
        });

        expect(found?.table).toBe("embeddings_768");
        expect(found?.row.model).toBe("m");
        expect(probes).toBe(1);
        expect(missing).toBeNull();
    });
});

describe("deleteVectorRow", () => {
    it("skips the table probe when the caller knows the table", async () => {
        expect.assertions(2);

        const { after, reads } = await run(async (ctx) => {
            const id = await ctx.db.insert("embeddings_1536", vector(1536));
            const get = vi.spyOn(ctx.db, "get");

            await deleteVectorRow(ctx.db as never, id, "embeddings_1536");

            return { after: await ctx.db.get("embeddings_1536", id), reads: get.mock.calls.length - 1 };
        });

        expect(reads).toBe(0);
        expect(after).toBeNull();
    });

    it("deletes a row of any dimension and ignores one that is already gone", async () => {
        expect.assertions(3);

        const [first, second, gone] = await run(async (ctx) => {
            const id = await ctx.db.insert("embeddings_1536", vector(1536));

            await deleteVectorRow(ctx.db as never, id);

            const after = await ctx.db.get("embeddings_1536", id);

            await deleteVectorRow(ctx.db as never, id);

            return [id, after, await ctx.db.get("embeddings_1536", id)];
        });

        expect(first).toBeTruthy();
        expect(second).toBeNull();
        expect(gone).toBeNull();
    });
});
