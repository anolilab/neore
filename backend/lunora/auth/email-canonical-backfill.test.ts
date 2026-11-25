/**
 * `user.emailCanonical` is filled through D1 (`user` is `.global()`), one batch per call, and never by picking one of two
 * accounts that fold to one address.
 */
import { canonicalEmail } from "@lunora/auth";
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import schema from "../schema";
import { backfillEmailCanonicalBatch, EMAIL_CANONICAL_BATCH, EMAIL_CANONICAL_FILL_STATEMENTS, EMAIL_CANONICAL_SCAN_PAGES } from "./email-canonical-backfill";

const userRow = (email: string, extra: Record<string, unknown> = {}) => {
    return { createdAt: 1, email, emailVerified: true, name: email, updatedAt: 1, ...extra };
};

/** Every user row as `[email, emailCanonical]`, in email order. */
const canonicals = async (ctx: any): Promise<[string, string | undefined][]> => {
    const { page } = await ctx.db.user.findMany({});

    return (page as { email: string; emailCanonical?: string }[])
        .map((row): [string, string | undefined] => [row.email, row.emailCanonical ?? undefined])
        .toSorted(([a], [b]) => a.localeCompare(b));
};

/**
 * `ctx` with its D1 statements counted as the deploy pays them: a read is one, a fill {@link EMAIL_CANONICAL_FILL_STATEMENTS}.
 * `hideHolders` makes the holder check see nothing, as when a sign-up takes an address between that check and the write.
 */
const counted = (ctx: any, options: { hideHolders?: boolean } = {}) => {
    const spent = { patches: 0, statements: 0 };
    const user = {
        findFirst: async (query: unknown) => {
            spent.statements += 1;

            return await ctx.db.user.findFirst(query);
        },
        findMany: async (query: { where?: { emailCanonical?: unknown } }) => {
            spent.statements += 1;

            const isHolderCheck = typeof query.where?.emailCanonical === "object" && query.where.emailCanonical !== null && "in" in query.where.emailCanonical;

            return options.hideHolders === true && isHolderCheck ? { isDone: true, page: [] } : await ctx.db.user.findMany(query);
        },
    };
    const db = {
        patchIf: async (...parameters: unknown[]) => {
            spent.patches += 1;
            spent.statements += EMAIL_CANONICAL_FILL_STATEMENTS;

            return await ctx.db.patchIf(...parameters);
        },
        user,
    };

    return { ctx: { db } as never, spent };
};

const withHarness = async <T>(body: (ctx: any) => Promise<T>): Promise<T> => {
    const harness = lunoraTest(schema as never);

    try {
        return await harness.run(body);
    } finally {
        harness.close();
    }
};

describe("the user.emailCanonical backfill", () => {
    it("fills a row that predates the column with the auth plugin's canonical address, and leaves a filled row alone", async () => {
        expect.assertions(3);

        const { result, rows } = await withHarness(async (ctx) => {
            await ctx.db.insert("user", userRow("  José@Example.com"));
            // A value the plugin would not compute, so a rewrite would show.
            await ctx.db.insert("user", userRow("kept@example.com", { emailCanonical: "kept-by-hand@example.com" }));

            return { result: await backfillEmailCanonicalBatch(ctx), rows: await canonicals(ctx) };
        });

        expect(result).toStrictEqual({ conflicts: 0, filled: 1, remaining: 0, status: "done" });
        expect(rows).toStrictEqual([
            ["  José@Example.com", canonicalEmail("  José@Example.com")],
            ["kept@example.com", "kept-by-hand@example.com"],
        ]);
        expect(canonicalEmail("  José@Example.com")).toBe("josé@example.com");
    });

    it("is a no-op once every row is filled: one read, no write", async () => {
        expect.assertions(2);

        const { second, spent } = await withHarness(async (ctx) => {
            await ctx.db.insert("user", userRow("Bob@Example.com"));
            await backfillEmailCanonicalBatch(ctx);

            const run = counted(ctx);

            return { second: await backfillEmailCanonicalBatch(run.ctx), spent: run.spent };
        });

        expect(second).toStrictEqual({ conflicts: 0, filled: 0, remaining: 0, status: "done" });
        expect(spent).toStrictEqual({ patches: 0, statements: 1 });
    });

    it("fills past one batch and past 25 rows in batches, each within the statement budget", async () => {
        expect.assertions(4);

        const total = 3 * EMAIL_CANONICAL_BATCH + 5;
        const { results, rows, statements } = await withHarness(async (ctx) => {
            for (let index = 0; index < total; index += 1) {
                await ctx.db.insert("user", userRow(`Person${String(index).padStart(2, "0")}@Example.com`));
            }

            const runs = [];
            const spentPerRun = [];

            for (let attempt = 0; attempt < 10; attempt += 1) {
                const run = counted(ctx);
                const result = await backfillEmailCanonicalBatch(run.ctx);

                runs.push(result);
                spentPerRun.push(run.spent.statements);

                if (result.status !== "progress") {
                    break;
                }
            }

            return { results: runs, rows: await canonicals(ctx), statements: spentPerRun };
        });

        expect(results.map((result) => result.filled)).toStrictEqual([EMAIL_CANONICAL_BATCH, EMAIL_CANONICAL_BATCH, EMAIL_CANONICAL_BATCH, 5]);
        expect(results.map((result) => result.status)).toStrictEqual(["progress", "progress", "progress", "done"]);
        expect(rows.every(([email, canonical]) => canonical === canonicalEmail(email))).toBe(true);
        // A scan, the holder check and the batch's fills; the Free plan allows 50, and the patch's retries need spare.
        expect(Math.max(...statements)).toBeLessThanOrEqual(EMAIL_CANONICAL_SCAN_PAGES + 1 + EMAIL_CANONICAL_BATCH * EMAIL_CANONICAL_FILL_STATEMENTS);
    });

    it("keeps its worst case well under the 50 statements a Worker invocation may send", () => {
        expect(EMAIL_CANONICAL_SCAN_PAGES + 1 + EMAIL_CANONICAL_BATCH * EMAIL_CANONICAL_FILL_STATEMENTS).toBeLessThanOrEqual(35);
        expect(EMAIL_CANONICAL_BATCH).toBeLessThanOrEqual(32);
    });

    it("refuses two unfilled rows that fold to one address and writes neither", async () => {
        expect.assertions(2);

        const { result, rows } = await withHarness(async (ctx) => {
            await ctx.db.insert("user", userRow("Bob@Example.com"));
            await ctx.db.insert("user", userRow("bob@example.com"));
            await ctx.db.insert("user", userRow("carol@example.com"));

            return { result: await backfillEmailCanonicalBatch(ctx), rows: await canonicals(ctx) };
        });

        expect(result).toStrictEqual({ conflicts: 1, filled: 0, remaining: 3, status: "conflict" });
        expect(rows.every(([, canonical]) => canonical === undefined)).toBe(true);
    });

    it("refuses a pair split across batches before its first write", async () => {
        expect.assertions(2);

        const { result, rows } = await withHarness(async (ctx) => {
            await ctx.db.insert("user", userRow("Dana@Example.com"));

            for (let index = 0; index < EMAIL_CANONICAL_BATCH + 2; index += 1) {
                await ctx.db.insert("user", userRow(`other${String(index)}@example.com`));
            }

            // Last, so it would fall in a later batch than the first.
            await ctx.db.insert("user", userRow("dana@example.com"));

            return { result: await backfillEmailCanonicalBatch(ctx), rows: await canonicals(ctx) };
        });

        expect(result.status).toBe("conflict");
        expect(rows.filter(([, canonical]) => canonical !== undefined)).toStrictEqual([]);
    });

    it("refuses a row whose address an existing account already holds", async () => {
        expect.assertions(2);

        const { result, rows } = await withHarness(async (ctx) => {
            await ctx.db.insert("user", userRow("eve@example.com", { emailCanonical: "eve@example.com" }));
            await ctx.db.insert("user", userRow("EVE@example.com"));

            return { result: await backfillEmailCanonicalBatch(ctx), rows: await canonicals(ctx) };
        });

        expect(result).toStrictEqual({ conflicts: 1, filled: 0, remaining: 1, status: "conflict" });
        expect(rows).toStrictEqual([
            ["eve@example.com", "eve@example.com"],
            ["EVE@example.com", undefined],
        ]);
    });

    it("answers a conflict, not an error, when a sign-up takes an address between the check and the write", async () => {
        expect.assertions(2);

        const { result, rows } = await withHarness(async (ctx) => {
            await ctx.db.insert("user", userRow("frank@example.com", { emailCanonical: "frank@example.com" }));
            await ctx.db.insert("user", userRow("FRANK@example.com"));

            return { result: await backfillEmailCanonicalBatch(counted(ctx, { hideHolders: true }).ctx), rows: await canonicals(ctx) };
        });

        expect(result).toMatchObject({ conflicts: 1, filled: 0, status: "conflict" });
        expect(rows).toContainEqual(["FRANK@example.com", undefined]);
    });
});
