/**
 * `user.emailCanonical` is filled through D1 (`user` is `.global()`): a check of every account first, then the fill one batch
 * per call, never by picking one of two accounts that fold to one address. The deploy's runner drives these calls here.
 */
import { canonicalEmail } from "@lunora/auth";
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import type { BackfillCall, BackfillRequest } from "../../../scripts/data-migrations";
import { runEmailCanonicalBackfill } from "../../../scripts/data-migrations";
import schema from "../schema";
import {
    checkEmailCanonicalPage,
    EMAIL_CANONICAL_BATCH,
    EMAIL_CANONICAL_FILL_PLAN,
    EMAIL_CANONICAL_FILL_STATEMENTS,
    EMAIL_CANONICAL_RETRY_HEADROOM,
    EMAIL_CANONICAL_SETTLE_MS,
    fillEmailCanonicalBatch,
} from "./email-canonical-backfill";

const NOW = 1_800_000_000_000;

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

interface CountOptions {
    /** Runs after the real conditional patch; may throw. */
    afterPatchIf?: () => void;
    /** Makes the holder check see nothing, as when a sign-up takes an address between that check and the write. */
    hideHolders?: boolean;
    /** Runs before the real conditional patch, with its arguments; may throw instead. */
    patchIf?: (ctx: any, id: string, call: number) => Promise<void>;
}

/**
 * `ctx` with its D1 statements counted as the deploy pays them (a read is one, a fill {@link EMAIL_CANONICAL_FILL_STATEMENTS}),
 * the rows its reads return, and the clock at {@link NOW}.
 */
const counted = (ctx: any, options: CountOptions = {}) => {
    const spent = { patches: 0, rowsRead: 0, statements: 0 };
    const user = {
        findFirst: async (query: unknown) => {
            spent.statements += 1;

            const row = await ctx.db.user.findFirst(query);

            spent.rowsRead += row === null ? 0 : 1;

            return row;
        },
        findMany: async (query: { where?: { emailCanonical?: unknown } }) => {
            spent.statements += 1;

            const isHolderCheck = typeof query.where?.emailCanonical === "object" && query.where.emailCanonical !== null && "in" in query.where.emailCanonical;
            const result = options.hideHolders === true && isHolderCheck ? { isDone: true, page: [] } : await ctx.db.user.findMany(query);

            spent.rowsRead += result.page.length;

            return result;
        },
    };
    const db = {
        patchIf: async (table: string, id: string, args: unknown) => {
            spent.patches += 1;
            spent.statements += EMAIL_CANONICAL_FILL_STATEMENTS;
            await options.patchIf?.(ctx, id, spent.patches);

            const result = await ctx.db.patchIf(table, id, args);

            options.afterPatchIf?.();

            return result;
        },
        user,
    };

    return { ctx: { db, now: NOW } as never, spent };
};

/** The deploy's runner against the real check and fill, with fake pauses; each call's statements are recorded. */
const runBackfill = async (ctx: any, options: CountOptions & { pageRows?: number; pages?: number } = {}) => {
    const perCall: number[] = [];
    const printed: string[] = [];
    const requests: BackfillRequest[] = [];
    const totals = { patches: 0, rowsRead: 0 };
    let salt = 0;
    const exitCode = await runEmailCanonicalBackfill({
        call: async (request): Promise<BackfillCall> => {
            const run = counted(ctx, options);

            requests.push(request);

            const body =
                request.phase === "check"
                    ? await checkEmailCanonicalPage(run.ctx, { cursor: request.cursor, pageRows: options.pageRows, pages: options.pages, salt: request.salt })
                    : await fillEmailCanonicalBatch(run.ctx, { checkedAt: request.checkedAt, cursor: request.cursor });

            perCall.push(run.spent.statements);
            totals.patches += run.spent.patches;
            totals.rowsRead += run.spent.rowsRead;

            return { body, status: body.status === "conflict" ? 409 : 200 };
        },
        error: (line) => {
            printed.push(line);
        },
        log: (line) => {
            printed.push(line);
        },
        salt: () => {
            salt += 1;

            return `salt-${String(salt)}`;
        },
        sleep: async () => {},
    });

    return { exitCode, output: printed.join("\n"), perCall, requests, totals };
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

        const { exitCode, rows } = await withHarness(async (ctx) => {
            await ctx.db.insert("user", userRow("  José@Example.com"));
            // A value the plugin would not compute, so a rewrite would show.
            await ctx.db.insert("user", userRow("kept@example.com", { emailCanonical: "kept-by-hand@example.com" }));

            const run = await runBackfill(ctx);

            return { exitCode: run.exitCode, rows: await canonicals(ctx) };
        });

        expect(exitCode).toBe(0);
        expect(rows).toStrictEqual([
            ["  José@Example.com", canonicalEmail("  José@Example.com")],
            ["kept@example.com", "kept-by-hand@example.com"],
        ]);
        expect(canonicalEmail("  José@Example.com")).toBe("josé@example.com");
    });

    it("is a no-op once every row is filled: one read, no write", async () => {
        expect.assertions(2);

        const { output, perCall } = await withHarness(async (ctx) => {
            await ctx.db.insert("user", userRow("Bob@Example.com"));
            await runBackfill(ctx);

            return await runBackfill(ctx);
        });

        expect(perCall).toStrictEqual([1]);
        expect(output).toBe("backfill-email-canonical: done, filled 0 over 1 call(s)");
    });

    it("fills past one batch and past 25 rows in batches, each call within the statement budget", async () => {
        expect.assertions(3);

        const total = 3 * EMAIL_CANONICAL_BATCH + 5;
        const { rows, run } = await withHarness(async (ctx) => {
            for (let index = 0; index < total; index += 1) {
                await ctx.db.insert("user", userRow(`Person${String(index).padStart(2, "0")}@Example.com`));
            }

            const result = await runBackfill(ctx);

            return { rows: await canonicals(ctx), run: result };
        });

        expect(run.exitCode).toBe(0);
        expect(rows.every(([email, canonical]) => canonical === canonicalEmail(email))).toBe(true);
        expect(Math.max(...run.perCall)).toBeLessThanOrEqual(EMAIL_CANONICAL_FILL_PLAN);
    });

    it("keeps its plan under the 50 statements a Worker invocation may send, with headroom for retry rounds", () => {
        expect(EMAIL_CANONICAL_FILL_PLAN).toBeLessThanOrEqual(30);
        expect(EMAIL_CANONICAL_FILL_PLAN + 1 + 2 * EMAIL_CANONICAL_RETRY_HEADROOM).toBeLessThanOrEqual(50);
        expect(EMAIL_CANONICAL_RETRY_HEADROOM).toBeGreaterThanOrEqual(8);
    });

    it("refuses two unfilled rows that fold to one address in one check call and writes neither", async () => {
        expect.assertions(3);

        const { rows, run } = await withHarness(async (ctx) => {
            await ctx.db.insert("user", userRow("Bob@Example.com"));
            await ctx.db.insert("user", userRow("bob@example.com"));
            await ctx.db.insert("user", userRow("carol@example.com"));

            const result = await runBackfill(ctx);

            return { rows: await canonicals(ctx), run: result };
        });

        expect(run.exitCode).toBe(1);
        expect(run.output).toContain("1 address(es) belong to more than one account");
        expect(rows.every(([, canonical]) => canonical === undefined)).toBe(true);
    });

    it("refuses a pair the check reads in different calls, past one call's window, before any write", async () => {
        expect.assertions(4);

        const { rows, run } = await withHarness(async (ctx) => {
            await ctx.db.insert("user", userRow("Dana@Example.com"));

            for (let index = 0; index < 12; index += 1) {
                await ctx.db.insert("user", userRow(`other${String(index)}@example.com`));
            }

            // Last, so a call that reads 2 × 2 rows never sees both.
            await ctx.db.insert("user", userRow("dana@example.com"));

            const result = await runBackfill(ctx, { pageRows: 2, pages: 2 });

            return { rows: await canonicals(ctx), run: result };
        });

        expect(run.exitCode).toBe(1);
        expect(run.output).toContain("1 address(es) belong to more than one account");
        expect(run.requests.every((request) => request.phase === "check")).toBe(true);
        expect(rows.filter(([, canonical]) => canonical !== undefined)).toStrictEqual([]);
    });

    it("refuses a row whose address an existing account holds, also when the check reads them in different calls", async () => {
        expect.assertions(3);

        const { rows, run } = await withHarness(async (ctx) => {
            await ctx.db.insert("user", userRow("eve@example.com", { emailCanonical: "eve@example.com" }));

            for (let index = 0; index < 6; index += 1) {
                await ctx.db.insert("user", userRow(`other${String(index)}@example.com`));
            }

            await ctx.db.insert("user", userRow("EVE@example.com"));

            const result = await runBackfill(ctx, { pageRows: 2, pages: 1 });

            return { rows: await canonicals(ctx), run: result };
        });

        expect(run.exitCode).toBe(1);
        expect(run.output).toContain("1 address(es) belong to more than one account");
        expect(rows.filter(([email, canonical]) => email !== "eve@example.com" && canonical !== undefined)).toStrictEqual([]);
    });

    it("reads each row a bounded number of times over a whole run, and a fill call only its batch", async () => {
        expect.assertions(3);

        const total = 5 * EMAIL_CANONICAL_BATCH;
        const run = await withHarness(async (ctx) => {
            for (let index = 0; index < total; index += 1) {
                await ctx.db.insert("user", userRow(`reader${String(index).padStart(2, "0")}@example.com`));
            }

            return await runBackfill(ctx);
        });

        expect(run.exitCode).toBe(0);
        // The first read, the check, every batch once, and the closing check's one read; no rescan per call.
        expect(run.totals.rowsRead).toBeLessThanOrEqual(2 * total + 2);
        expect(run.requests.filter((request) => request.phase === "fill")).toHaveLength(total / EMAIL_CANONICAL_BATCH);
    });

    it("leaves a row changed since the check began, and fills it in a later round once it settled", async () => {
        expect.assertions(3);

        const { first, rows } = await withHarness(async (ctx) => {
            await ctx.db.insert("user", userRow("old@example.com"));
            await ctx.db.insert("user", userRow("Fresh@example.com", { updatedAt: NOW - EMAIL_CANONICAL_SETTLE_MS + 1 }));

            const fill = await fillEmailCanonicalBatch(counted(ctx).ctx, { checkedAt: NOW });

            return { first: fill, rows: await canonicals(ctx) };
        });

        expect(first).toStrictEqual({ conflicts: 0, filled: 1, skipped: 1, status: "filled" });
        expect(rows).toStrictEqual([
            ["Fresh@example.com", undefined],
            ["old@example.com", "old@example.com"],
        ]);

        const settled = await withHarness(async (ctx) => {
            await ctx.db.insert("user", userRow("Fresh@example.com", { updatedAt: NOW - EMAIL_CANONICAL_SETTLE_MS }));

            return await fillEmailCanonicalBatch(counted(ctx).ctx, { checkedAt: NOW });
        });

        expect(settled.filled).toBe(1);
    });

    it("stops a fill call after a write that other writes raced, and the next call goes on from the same batch", async () => {
        expect.assertions(4);

        const { first, rows, second } = await withHarness(async (ctx) => {
            for (let index = 0; index < EMAIL_CANONICAL_BATCH; index += 1) {
                await ctx.db.insert("user", userRow(`raced${String(index)}@example.com`));
            }

            // A write that leaves `updatedAt`, `email` and `emailCanonical` as they were (a role change does), landing on the
            // second fill: the conditional patch goes round again, and how often is not reported.
            const raced = counted(ctx, {
                patchIf: async (inner, id, call) => {
                    if (call === 2) {
                        await inner.db.patch("user", id, { role: "admin" });
                    }
                },
            });
            const firstCall = await fillEmailCanonicalBatch(raced.ctx, { checkedAt: NOW });
            const secondCall = await fillEmailCanonicalBatch(counted(ctx).ctx, { checkedAt: NOW, cursor: firstCall.cursor });

            return { first: firstCall, rows: await canonicals(ctx), second: secondCall };
        });

        expect(first).toStrictEqual({ conflicts: 0, filled: 2, skipped: 0, status: "progress" });
        expect(first.cursor).toBeUndefined();
        expect(second).toMatchObject({ filled: EMAIL_CANONICAL_BATCH - 2, status: "filled" });
        expect(rows.every(([email, canonical]) => canonical === canonicalEmail(email))).toBe(true);
    });

    it("answers a conflict, not an error, when a sign-up takes an address between the check and the write", async () => {
        expect.assertions(2);

        const { result, rows } = await withHarness(async (ctx) => {
            await ctx.db.insert("user", userRow("frank@example.com", { emailCanonical: "frank@example.com" }));
            await ctx.db.insert("user", userRow("FRANK@example.com"));

            return { result: await fillEmailCanonicalBatch(counted(ctx, { hideHolders: true }).ctx, { checkedAt: NOW }), rows: await canonicals(ctx) };
        });

        expect(result).toMatchObject({ conflicts: 1, filled: 0, status: "conflict" });
        expect(rows).toContainEqual(["FRANK@example.com", undefined]);
    });

    it("rethrows a failed write that is not a duplicate address, also when the row itself holds the value", async () => {
        expect.assertions(1);

        const failures = await withHarness(async (ctx) => {
            await ctx.db.insert("user", userRow("gina@example.com"));
            await ctx.db.insert("user", userRow("hank@example.com"));

            const outcomes: string[] = [];

            // The write lands, then the audit insert fails: the holder is the row itself.
            await fillEmailCanonicalBatch(
                counted(ctx, {
                    afterPatchIf: () => {
                        throw new Error("audit write failed");
                    },
                }).ctx,
                { checkedAt: NOW },
            ).catch((error: unknown) => {
                outcomes.push((error as Error).message);
            });

            // The write never lands: there is no holder.
            await fillEmailCanonicalBatch(
                counted(ctx, {
                    patchIf: async () => {
                        throw new Error("D1 unavailable");
                    },
                }).ctx,
                { checkedAt: NOW },
            ).catch((error: unknown) => {
                outcomes.push((error as Error).message);
            });

            return outcomes;
        });

        expect(failures).toStrictEqual(["audit write failed", "D1 unavailable"]);
    });
});
