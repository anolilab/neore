import { describe, expect, it, vi } from "vitest";

import { searchVectors } from "./index";

/** The filter `ctx.vectors.query` received — what Vectorize is asked to match. */
const filterOf = async (args: Parameters<typeof searchVectors>[2]): Promise<unknown> => {
    const query = vi.fn(async () => {
        return { count: 0, matches: [] };
    });

    await searchVectors({ vectors: { query } } as never, [0.1, 0.2], args);

    return (query.mock.calls[0] as unknown as [string, { filter: unknown }])[1].filter;
};

describe(searchVectors, () => {
    it("filters on one string — a Vectorize filter cannot match an array", async () => {
        expect(await filterOf({ dimension: 128, model: "m", searchAllMessagesForUserId: "u1", table: "memories" })).toStrictEqual({
            model_table_userId: "m|memories|u1",
        });
        expect(await filterOf({ dimension: 128, model: "m", table: "messages", threadId: "t1" as never })).toStrictEqual({
            model_table_threadId: "m|messages|t1",
        });
    });
});
