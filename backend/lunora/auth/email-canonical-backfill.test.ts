/**
 * `user.emailCanonical` is filled through D1 (`user` is `.global()`): a check of every account first, then the fill one batch
 * per call, never by picking one of two accounts that fold to one address. The deploy's runner drives these calls here.
 */
import { canonicalEmail } from "@lunora/auth";
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import type { BackfillCall, BackfillRequest } from "../../../scripts/data-migrations";
import { EMAIL_CANONICAL_FILL_IDS, runEmailCanonicalBackfill } from "../../../scripts/data-migrations";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import {
    checkEmailCanonical,
    checkEmailCanonicalPage,
    EMAIL_CANONICAL_BATCH,
    EMAIL_CANONICAL_FILL_PLAN,
    EMAIL_CANONICAL_FILL_STATEMENTS,
    EMAIL_CANONICAL_RETRY_HEADROOM,
    EMAIL_CANONICAL_SETTLE_MS,
    fillEmailCanonical,
    fillEmailCanonicalBatch,
} from "./email-canonical-backfill";

const NOW = 1_800_000_000_000;
const CREATION_INDEX_SEEK = /^SEARCH user USING INDEX user__by_creation \(_creationTime>\?\)$/u;
const PRIMARY_KEY_SEARCH = /^SEARCH user USING INDEX sqlite_autoindex_user_1 \(id=\?\)( \| USE TEMP B-TREE FOR ORDER BY)?$/u;

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

/** The ids of the unfilled rows, in creation order, as a check answers them. */
const unfilledIds = async (ctx: any): Promise<Id<"user">[]> => {
    const { page } = await ctx.db.user.findMany({});

    return (page as { _id: Id<"user">; emailCanonical?: string }[]).filter((row) => row.emailCanonical === undefined).map((row) => row._id);
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
                    : await fillEmailCanonicalBatch(run.ctx, { checkedAt: request.checkedAt, ids: request.ids as Id<"user">[] });

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
        production: false,
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
        // The runner sends this many ids per fill; the route refuses more.
        expect(EMAIL_CANONICAL_FILL_IDS).toBe(EMAIL_CANONICAL_BATCH);
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

            const fill = await fillEmailCanonicalBatch(counted(ctx).ctx, { checkedAt: NOW, ids: await unfilledIds(ctx) });

            return { first: fill, rows: await canonicals(ctx) };
        });

        expect(first).toStrictEqual({ conflicts: 0, filled: 1, processed: 2, skipped: 1, status: "progress" });
        expect(rows).toStrictEqual([
            ["Fresh@example.com", undefined],
            ["old@example.com", "old@example.com"],
        ]);

        const settled = await withHarness(async (ctx) => {
            await ctx.db.insert("user", userRow("Fresh@example.com", { updatedAt: NOW - EMAIL_CANONICAL_SETTLE_MS }));

            return await fillEmailCanonicalBatch(counted(ctx).ctx, { checkedAt: NOW, ids: await unfilledIds(ctx) });
        });

        expect(settled.filled).toBe(1);
    });

    it("stops a fill call after a write that other writes raced, and the next call goes on with the ids after it", async () => {
        expect.assertions(3);

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
            const ids = await unfilledIds(ctx);
            const firstCall = await fillEmailCanonicalBatch(raced.ctx, { checkedAt: NOW, ids });
            const secondCall = await fillEmailCanonicalBatch(counted(ctx).ctx, { checkedAt: NOW, ids: ids.slice(firstCall.processed) });

            return { first: firstCall, rows: await canonicals(ctx), second: secondCall };
        });

        expect(first).toStrictEqual({ conflicts: 0, filled: 2, processed: 2, skipped: 0, status: "progress" });
        expect(second).toMatchObject({ filled: EMAIL_CANONICAL_BATCH - 2, processed: EMAIL_CANONICAL_BATCH - 2 });
        expect(rows.every(([email, canonical]) => canonical === canonicalEmail(email))).toBe(true);
    });

    it("answers a conflict, not an error, when a sign-up takes an address between the check and the write", async () => {
        expect.assertions(2);

        const { result, rows } = await withHarness(async (ctx) => {
            await ctx.db.insert("user", userRow("frank@example.com", { emailCanonical: "frank@example.com" }));
            await ctx.db.insert("user", userRow("FRANK@example.com"));

            return {
                result: await fillEmailCanonicalBatch(counted(ctx, { hideHolders: true }).ctx, { checkedAt: NOW, ids: await unfilledIds(ctx) }),
                rows: await canonicals(ctx),
            };
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
                { checkedAt: NOW, ids: await unfilledIds(ctx) },
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
                { checkedAt: NOW, ids: await unfilledIds(ctx) },
            ).catch((error: unknown) => {
                outcomes.push((error as Error).message);
            });

            return outcomes;
        });

        expect(failures).toStrictEqual(["audit write failed", "D1 unavailable"]);
    });
    it("does not take a column stored as null for a raced write", async () => {
        expect.assertions(1);

        const result = await withHarness(async (ctx) => {
            for (let index = 0; index < EMAIL_CANONICAL_BATCH; index += 1) {
                const id = await ctx.db.insert("user", userRow(`nulled${String(index)}@example.com`, { role: "admin" }));

                // `auth/admin.ts` clears a role this way; the column then reads back as null.
                await ctx.db.patch("user", id, { role: null });
            }

            return await fillEmailCanonicalBatch(counted(ctx).ctx, { checkedAt: NOW, ids: await unfilledIds(ctx) });
        });

        expect(result).toStrictEqual({ conflicts: 0, filled: EMAIL_CANONICAL_BATCH, processed: EMAIL_CANONICAL_BATCH, skipped: 0, status: "progress" });
    });

    it("reads a check page and a fill's rows through an index, never sorting the unfilled rows", async () => {
        expect.assertions(2);

        const plans = await withHarness(async (ctx) => {
            for (let index = 0; index < 3; index += 1) {
                await ctx.db.insert("user", userRow(`planned${String(index)}@example.com`));
            }

            const ids = await unfilledIds(ctx);
            const { continueCursor } = await ctx.db.user.findMany({ limit: 1 });
            const plan = async (query: unknown): Promise<string> => ((await ctx.db.explain("user", query)) as { plan: string[] }).plan.join(" | ");

            return {
                check: await plan({ consistency: "primary", cursor: continueCursor, limit: 1000 }),
                fill: await plan({ consistency: "primary", limit: ids.length, where: { _id: { in: ids } } }),
            };
        });

        // A keyset seek on the creation index, and a primary-key search whose sort covers the batch alone.
        expect(plans.check).toMatch(CREATION_INDEX_SEEK);
        expect(plans.fill).toMatch(PRIMARY_KEY_SEARCH);
    });

    it("runs through the registered mutations, whose output validators take every answer", async () => {
        expect.assertions(4);

        const answers = await withHarness(async (ctx) => {
            await ctx.db.insert("user", userRow("Ivy@example.com"));
            await ctx.db.insert("user", userRow("kept@example.com", { emailCanonical: "kept@example.com" }));

            const checked = await ctx.runMutation(checkEmailCanonical, { salt: "s" });
            const filled = await ctx.runMutation(fillEmailCanonical, { checkedAt: checked.checkedAt + EMAIL_CANONICAL_SETTLE_MS, ids: checked.unfilledIds });
            const done = await ctx.runMutation(checkEmailCanonical, { cursor: undefined, salt: "s" });

            await ctx.db.insert("user", userRow("JOE@example.com"));
            await ctx.db.insert("user", userRow("joe@example.com"));

            return { checked, conflict: await ctx.runMutation(checkEmailCanonical, { salt: "s" }), done, filled };
        });

        expect(answers.checked).toMatchObject({ scanned: 2, status: "checked" });
        expect(answers.filled).toStrictEqual({ conflicts: 0, filled: 1, processed: 1, skipped: 0, status: "progress" });
        expect(answers.done).toStrictEqual({ status: "done" });
        expect(answers.conflict).toStrictEqual({ conflicts: 1, status: "conflict" });
    });
});
