/**
 * `user.emailCanonical` is filled through D1 (`user` is `.global()`): a check of every account first, then the fill one id
 * per call from that completed check, never by picking one of two accounts that fold to one address. The deploy's runner
 * drives these calls here.
 */
import { DatabaseSync } from "node:sqlite";

import { canonicalEmail, resolveAuthOptions } from "@lunora/auth";
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it, vi } from "vitest";

import type { BackfillCall, BackfillRequest } from "../../../scripts/data-migrations";
import { runEmailCanonicalBackfill } from "../../../scripts/data-migrations";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import {
    checkEmailCanonical,
    checkEmailCanonicalPage,
    D1_RESULT_ROWS,
    EMAIL_CANONICAL_CHECK_PAGES,
    EMAIL_CANONICAL_CHECK_ROWS,
    EMAIL_CANONICAL_CHECK_SCOPE,
    EMAIL_CANONICAL_FILL_WORST,
    EMAIL_CANONICAL_SETTLE_MS,
    fillEmailCanonical,
    fillEmailCanonicalBatch,
    INVOCATION_D1_QUERIES,
    PATCH_IF_ATTEMPTS,
} from "./email-canonical-backfill";

const NOW = 1_800_000_000_000;
const CREATION_INDEX_SEEK = /^SEARCH user USING INDEX user__by_creation \(_creationTime>\?\)$/u;
const PRIMARY_KEY_SEARCH = /^SEARCH user USING INDEX sqlite_autoindex_user_1 \(id=\?\)( \| USE TEMP B-TREE FOR ORDER BY)?$/u;
/** Past the 512 characters the route once capped a cursor at. */
const LONG_CURSOR_PAD = "c".repeat(700);

const userRow = (email: string, extra: Record<string, unknown> = {}) => {
    return { createdAt: 1, email, emailVerified: true, name: email, updatedAt: 1, ...extra };
};

/**
 * Stores a `user` row's dates as better-auth leaves them in D1: its Lunora adapter sets `supportsDates: false` and writes
 * past Lunora's validators, so `createdAt`/`updatedAt` hold ISO strings in `v.number()` columns. The harness validates its
 * writes, so the row is rewritten under it, in the document its SQLite holds. A date not given is the stored one as ISO.
 */
const storeDatesAsText = (email: string, dates: { banExpires?: string; createdAt?: string; updatedAt?: string } = {}): void => {
    const table = harnessSqlite!.prepare(`SELECT id, __doc__ FROM "user" WHERE json_extract(__doc__, '$.email') = ?`);
    const { __doc__: stored, id } = table.get(email) as { __doc__: string; id: string };
    const doc = JSON.parse(stored) as Record<string, unknown>;

    for (const column of ["createdAt", "updatedAt"] as const) {
        doc[column] = dates[column] ?? new Date(doc[column] as number).toISOString();
    }

    if (dates.banExpires !== undefined) {
        doc["banExpires"] = dates.banExpires;
    }

    harnessSqlite!.prepare(`UPDATE "user" SET __doc__ = ? WHERE id = ?`).run(JSON.stringify(doc), id);
};

/** Every user row as `[email, emailCanonical]`, in email order. */
const canonicals = async (ctx: any): Promise<[string, string | undefined][]> => {
    const { page } = await ctx.db.user.findMany({});

    return (page as { email: string; emailCanonical?: string }[])
        .map((row): [string, string | undefined] => [row.email, row.emailCanonical ?? undefined])
        .toSorted(([a], [b]) => a.localeCompare(b));
};

const userIdOf = async (ctx: any, email: string): Promise<Id<"user">> => ((await ctx.db.user.findFirst({ where: { email } })) as { _id: Id<"user"> })._id;

interface CountOptions {
    /** Runs after the real conditional patch; may throw. */
    afterPatchIf?: () => void;
    /** Runs before each write to a check's claims (shard-local), with the write's method; may run other calls meanwhile. */
    beforeClaimWrite?: (method: string) => Promise<void>;
    /** Runs before each read of `user` rows, with its query; may run other calls meanwhile. */
    beforeFindMany?: (query: { cursor?: unknown }) => Promise<void>;
    /** Emulates D1's cap on the rows one statement answers: Lunora asks for a page's `limit` plus one. */
    d1RowCap?: number;
    /** Makes the holder check see nothing, as when a sign-up takes an address between that check and the write. */
    hideHolders?: boolean;
    /** Hands out every cursor padded past 512 characters, as a long keyset cursor would be. */
    longCursors?: boolean;
    /** The call's clock; {@link NOW} without one. */
    now?: number;
    /** Runs before the real conditional patch, with its arguments; may throw instead. */
    patchIf?: (ctx: any, id: string, call: number) => Promise<void>;
    /** Rounds the conditional patch goes before it applies, each charged a read and a write; at {@link PATCH_IF_ATTEMPTS} it throws `occ`. */
    patchRounds?: number;
}

/**
 * `ctx` with its D1 statements counted as the deploy pays them (a read is one; a conditional patch two per round and its
 * audit insert one), the rows its reads return, and the clock at {@link NOW}. Shard-local claim reads and writes pass
 * through uncounted: they are not D1's.
 */
const counted = (ctx: any, options: CountOptions = {}) => {
    const spent = { patches: 0, queries: [] as unknown[], rowsRead: 0, statements: 0 };
    const unpad = (cursor: unknown) => (typeof cursor === "string" && options.longCursors === true ? cursor.slice(LONG_CURSOR_PAD.length) : cursor);
    const user = {
        findFirst: async (query: unknown) => {
            spent.statements += 1;

            const row = await ctx.db.user.findFirst(query);

            spent.rowsRead += row === null ? 0 : 1;

            return row;
        },
        findMany: async (input: { cursor?: string; limit?: number; where?: { emailCanonical?: unknown } }) => {
            spent.statements += 1;

            const query = { ...input, cursor: unpad(input.cursor) };

            spent.queries.push(query);
            await options.beforeFindMany?.(query);
            const isHolderCheck = typeof query.where?.emailCanonical === "object" && query.where.emailCanonical !== null && "in" in query.where.emailCanonical;
            let result: { continueCursor?: string | null; isDone: boolean; page: unknown[] };

            if (options.hideHolders === true && isHolderCheck) {
                result = { isDone: true, page: [] };
            } else if (options.d1RowCap !== undefined && query.limit !== undefined && query.limit + 1 > options.d1RowCap) {
                // D1 answers no more than the cap, so the row past the page that would say "more" never arrives.
                const { page } = await ctx.db.user.findMany({ ...query, limit: Math.min(query.limit, options.d1RowCap) });

                result = { continueCursor: null, isDone: true, page };
            } else {
                result = await ctx.db.user.findMany(query);
            }

            spent.rowsRead += result.page.length;

            return options.longCursors === true && typeof result.continueCursor === "string"
                ? { ...result, continueCursor: `${LONG_CURSOR_PAD}${result.continueCursor}` }
                : result;
        },
    };
    const claimWrite =
        (target: any, method: string) =>
        async (table: string, ...rest: unknown[]): Promise<unknown> => {
            if (table === "idempotencyClaims") {
                await options.beforeClaimWrite?.(method);
            }

            return await target[method](table, ...rest);
        };
    const patchIf = async (table: string, id: string, args: unknown) => {
        if (table !== "user") {
            // A check record's conditional write: the root shard's SQLite, not D1.
            return await claimWrite(ctx.db, "patchIf")(table, id, args);
        }

        const rounds = options.patchRounds ?? 1;

        spent.patches += 1;
        spent.statements += 2 * Math.min(rounds, PATCH_IF_ATTEMPTS);

        if (rounds >= PATCH_IF_ATTEMPTS) {
            throw new Error(`patchIf on "user" lost the row to concurrent writes ${String(PATCH_IF_ATTEMPTS)} times in a row`);
        }

        await options.patchIf?.(ctx, id, spent.patches);

        const result = await ctx.db.patchIf(table, id, args);

        // The audit trigger's `documentHistory` insert, charged before it can fail.
        spent.statements += result.applied ? 1 : 0;
        options.afterPatchIf?.();

        return result;
    };
    const db = new Proxy(ctx.db, {
        get: (target, key) => {
            if (key === "user") {
                return user;
            }

            if (key === "patchIf") {
                return patchIf;
            }

            if (typeof key === "string" && ["delete", "insert", "patch"].includes(key)) {
                return claimWrite(target, key);
            }

            const value = Reflect.get(target, key);

            return typeof value === "function" ? value.bind(target) : value;
        },
    });

    return { ctx: { db, now: options.now ?? NOW } as never, spent };
};

/** The deploy's runner against the real check and fill, with fake pauses; each call's statements are recorded. */
const runBackfill = async (ctx: any, options: CountOptions & { pageRows?: number; pages?: number } = {}) => {
    const perCall: { phase: string; statements: number }[] = [];
    const printed: string[] = [];
    const requests: BackfillRequest[] = [];
    const totals = { patches: 0, rowsRead: 0 };
    const exitCode = await runEmailCanonicalBackfill({
        call: async (request): Promise<BackfillCall> => {
            const run = counted(ctx, options);

            requests.push(request);

            const body =
                request.phase === "check"
                    ? await checkEmailCanonicalPage(run.ctx, { pageRows: options.pageRows, pages: options.pages, token: request.token })
                    : await fillEmailCanonicalBatch(run.ctx, { ids: request.ids as Id<"user">[], token: request.token });

            perCall.push({ phase: request.phase, statements: run.spent.statements });
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
        sleep: async () => {},
    });

    return { exitCode, output: printed.join("\n"), perCall, requests, totals };
};

/** A check run to its end over `ctx`: its token and the unfilled ids it recorded. */
const completedCheck = async (ctx: any, options: CountOptions = {}): Promise<{ ids: Id<"user">[]; token: string }> => {
    const ids: Id<"user">[] = [];
    let token: string | undefined;

    for (;;) {
        const answer = await checkEmailCanonicalPage(counted(ctx, options).ctx, { ...(token !== undefined && { token }) });

        if (answer.status !== "checked" && answer.status !== "checking") {
            throw new Error(`the check answered ${answer.status}`);
        }

        ids.push(...answer.unfilledIds);
        token = answer.token;

        if (answer.status === "checked") {
            return { ids, token };
        }
    }
};

const refusal = async (work: Promise<unknown>): Promise<string> => {
    try {
        await work;
    } catch (error) {
        return (error as { code?: string }).code ?? (error as Error).message;
    }

    return "not refused";
};

/** The SQLite under the latest {@link withHarness}. */
let harnessSqlite: DatabaseSync | undefined;

const withHarness = async <T>(body: (ctx: any) => Promise<T>): Promise<T> => {
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const harness = lunoraTest(schema as never);

    harnessSqlite = prepare.mock.contexts[0] as DatabaseSync;
    prepare.mockRestore();

    try {
        return await harness.run(body);
    } finally {
        harness.close();
    }
};

// Each test runs a whole harness (a fresh database and a cold import) inside a shard that shares its machine with the others. Under that
// load several take 2 to 6 seconds alone, past the 5-second default, which is why the shard failed on a timeout rather than an assertion.
describe("the user.emailCanonical backfill", { timeout: 30_000 }, () => {
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

    it("is a no-op once every row is filled: one read, no write, no check record", async () => {
        expect.assertions(3);

        const { claims, run } = await withHarness(async (ctx) => {
            await ctx.db.insert("user", userRow("Bob@Example.com"));
            await runBackfill(ctx);

            const before: unknown[] = await ctx.db.query("idempotencyClaims").collect();
            const result = await runBackfill(ctx);
            const after: unknown[] = await ctx.db.query("idempotencyClaims").collect();

            return { claims: after.length - before.length, run: result };
        });

        expect(run.perCall).toStrictEqual([{ phase: "check", statements: 1 }]);
        expect(run.output).toBe("backfill-email-canonical: done, filled 0 over 1 call(s)");
        expect(claims).toBe(0);
    });

    it("fills past 25 rows, one id per fill call, each call (a check of one-row pages too) within the statement budget", async () => {
        expect.assertions(5);

        const total = 30;
        const { rows, run } = await withHarness(async (ctx) => {
            for (let index = 0; index < total; index += 1) {
                await ctx.db.insert("user", userRow(`Person${String(index).padStart(2, "0")}@Example.com`));
            }

            // One-row pages, so the first check call reads every page it may: its first read and EMAIL_CANONICAL_CHECK_PAGES.
            const result = await runBackfill(ctx, { pageRows: 1 });

            return { rows: await canonicals(ctx), run: result };
        });

        expect(run.exitCode).toBe(0);
        expect(rows.every(([email, canonical]) => canonical === canonicalEmail(email))).toBe(true);
        expect(run.requests.filter((request) => request.phase === "fill")).toHaveLength(total);
        expect(Math.max(...run.perCall.map(({ statements }) => statements))).toBeLessThanOrEqual(INVOCATION_D1_QUERIES);
        expect(run.perCall[0]).toStrictEqual({ phase: "check", statements: 1 + EMAIL_CANONICAL_CHECK_PAGES });
    });

    it("checks every row of a table past one page under D1's row cap, never taking a full page for the end", async () => {
        expect.assertions(2);

        const total = D1_RESULT_ROWS + 1;
        const answers = await withHarness(async (ctx) => {
            for (let index = 0; index < total; index += 1) {
                await ctx.db.insert("user", userRow(`capped${String(index).padStart(4, "0")}@example.com`));
            }

            const seen: { scanned: number; status: string }[] = [];
            let token: string | undefined;

            for (let call = 0; call < 5; call += 1) {
                const answer = await checkEmailCanonicalPage(counted(ctx, { d1RowCap: D1_RESULT_ROWS }).ctx, {
                    pages: 1,
                    ...(token !== undefined && { token }),
                });

                if (answer.status !== "checked" && answer.status !== "checking") {
                    throw new Error(answer.status);
                }

                seen.push({ scanned: answer.scanned, status: answer.status });
                token = answer.token;

                if (answer.status === "checked") {
                    break;
                }
            }

            return seen;
        });

        expect(answers.reduce((sum, { scanned }) => sum + scanned, 0)).toBe(total);
        expect(answers.at(-1)?.status).toBe("checked");
    });

    it.each([
        ["exactly one page", 3, ["checked"]],
        ["one row past a page", 4, ["checking", "checked"]],
    ])("reads a table of %s to its end through Lunora's isDone and continueCursor", async (_label, total, statuses) => {
        expect.assertions(2);

        const answers = await withHarness(async (ctx) => {
            for (let index = 0; index < total; index += 1) {
                await ctx.db.insert("user", userRow(`edge${String(index)}@example.com`));
            }

            const seen: { ids: number; status: string }[] = [];
            let token: string | undefined;

            for (;;) {
                const answer = await checkEmailCanonicalPage(counted(ctx).ctx, { pageRows: 3, pages: 1, ...(token !== undefined && { token }) });

                if (answer.status !== "checked" && answer.status !== "checking") {
                    throw new Error(answer.status);
                }

                seen.push({ ids: answer.unfilledIds.length, status: answer.status });
                token = answer.token;

                if (answer.status === "checked") {
                    return seen;
                }
            }
        });

        expect(answers.map(({ status }) => status)).toStrictEqual(statuses);
        expect(answers.reduce((sum, { ids }) => sum + ids, 0)).toBe(total);
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

    it("refuses a filled row whose stored canonical is stale and an unfilled row whose address folds to the filled row's", async () => {
        expect.assertions(3);

        const { rows, run } = await withHarness(async (ctx) => {
            await ctx.db.insert("user", userRow("Kim@Example.com", { emailCanonical: "kim-before-a-rename@example.com" }));
            await ctx.db.insert("user", userRow("kim@example.com"));

            const result = await runBackfill(ctx);

            return { rows: await canonicals(ctx), run: result };
        });

        expect(run.exitCode).toBe(1);
        expect(run.output).toContain("1 address(es) belong to more than one account");
        expect(rows).toContainEqual(["kim@example.com", undefined]);
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

    it("reads every row past a page boundary among rows that share one creation time, and refuses a pair split across it", async () => {
        expect.assertions(5);

        const ROWS = 7;
        const { boundary, conflict, pagesRead, scanned, unfilled } = await withHarness(async (ctx) => {
            // One creation time for every row, so the pages split inside a tie and only the id orders them.
            const clock = vi.spyOn(Date, "now").mockReturnValue(NOW - 60_000);

            try {
                for (let index = 0; index < ROWS; index += 1) {
                    await ctx.db.insert("user", userRow(`tied${String(index)}@example.com`));
                }
            } finally {
                clock.mockRestore();
            }

            const run = counted(ctx);
            const checked = await checkEmailCanonicalPage(run.ctx, { pageRows: 2, pages: ROWS });

            if (checked.status !== "checked") {
                throw new Error(`the check ended "${checked.status}"`);
            }

            // The last row of the first page and the first of the next, read in the check's own cursor order.
            const first = await ctx.db.user.findMany({ consistency: "primary", limit: 2 });
            const second = await ctx.db.user.findMany({ consistency: "primary", cursor: first.continueCursor ?? undefined, limit: 2 });
            const last = (first.page as { _id: Id<"user"> }[]).at(-1)!._id;
            const next = (second.page as { _id: Id<"user"> }[])[0]!._id;

            await ctx.db.patch("user", last, { email: "Tied@Example.com" });
            await ctx.db.patch("user", next, { email: "tied@example.com" });

            return {
                // Two full pages and two different rows, so the pair the check must refuse straddles the boundary.
                boundary: [first.page.length, second.page.length, last === next],
                conflict: await checkEmailCanonicalPage(counted(ctx).ctx, { pageRows: 2, pages: ROWS }),
                // Past the start's one-row probe for an unfilled row.
                pagesRead: run.spent.queries.filter((query) => (query as { where?: unknown }).where === undefined).length,
                scanned: checked.scanned,
                unfilled: new Set(checked.unfilledIds).size,
            };
        });

        expect(pagesRead).toBe(Math.ceil(ROWS / 2));
        expect(scanned).toBe(ROWS);
        expect(unfilled).toBe(ROWS);
        expect(boundary).toStrictEqual([2, 2, false]);
        expect(conflict).toStrictEqual({ conflicts: 1, status: "conflict" });
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

    it("refuses a later account once an account the check already read takes its address through the auth plugin", async () => {
        expect.assertions(3);

        // The plugin's own update hook, as `createAuth` wraps it: an email change writes the folded address with it.
        const { databaseHooks } = resolveAuthOptions({ baseURL: "http://localhost:8788", secret: "s".repeat(40) });
        const changeEmail = async (ctx: any, id: Id<"user">, email: string): Promise<void> => {
            const hooked = (await databaseHooks!.user!.update!.before!({ email } as never, null)) as { data: Record<string, unknown> };

            await ctx.db.patch("user", id, { ...hooked.data, email, updatedAt: NOW });
        };

        const { answers, rows, target } = await withHarness(async (ctx) => {
            for (const email of ["Alpha@Example.com", "Bravo@Example.com", "Charlie@Example.com"]) {
                await ctx.db.insert("user", userRow(email));
            }

            // One row per call: the account the first call reads then takes the address of one a later call reads.
            const opened = await checkEmailCanonicalPage(counted(ctx).ctx, { pageRows: 1, pages: 1 });

            if (opened.status !== "checking") {
                throw new Error(`the check answered ${opened.status}`);
            }

            const [changed] = opened.unfilledIds;
            const { page } = await ctx.db.user.findMany({});
            const later = (page as { _id: Id<"user">; email: string }[]).find((row) => row._id !== changed)!;

            await changeEmail(ctx, changed!, later.email.toLowerCase());

            const ids = [...opened.unfilledIds];
            let answer = opened;

            while (answer.status === "checking") {
                answer = (await checkEmailCanonicalPage(counted(ctx).ctx, { pageRows: 1, pages: 1, token: opened.token })) as typeof opened;
                ids.push(...answer.unfilledIds);
            }

            const roles = new Map<string, string>([
                [changed!, "changed"],
                [later._id, "later"],
            ]);
            const fills = new Map<string, string>();

            for (const id of ids) {
                const { status } = await fillEmailCanonicalBatch(counted(ctx).ctx, { ids: [id], token: opened.token });

                fills.set(roles.get(id) ?? "other", status);
            }

            return { answers: Object.fromEntries(fills), rows: await canonicals(ctx), target: later.email };
        });

        expect(answers).toStrictEqual({ changed: "progress", later: "conflict", other: "progress" });
        // The changed account holds the address since its change; the later one stays unfilled.
        expect(rows.filter(([email]) => email === target || email === target.toLowerCase())).toStrictEqual([
            [target.toLowerCase(), target.toLowerCase()],
            [target, undefined],
        ]);
        expect(new Set(rows.flatMap(([, canonical]) => (canonical === undefined ? [] : [canonical]))).size).toBe(2);
    });

    it.each([
        ["before its reads", "beforeFindMany", undefined],
        ["after its reads, before its first write", "beforeClaimWrite", undefined],
        // Between the record swap's own read and its conditional write: the write's guard alone decides.
        ["between its record swap's read and write", "beforeClaimWrite", "patchIf"],
    ] as const)(
        "lets a continuation that lost to a newer one under the same token (paused %s) save nothing, so the completed check still fills",
        async (_, pausePoint, onlyMethod) => {
            expect.assertions(4);

            const { fill, paused, rows, stale } = await withHarness(async (ctx) => {
                for (let index = 0; index < 3; index += 1) {
                    await ctx.db.insert("user", userRow(`racer${String(index)}@example.com`));
                }

                const opened = await checkEmailCanonicalPage(counted(ctx).ctx, { pageRows: 1, pages: 1 });

                if (opened.status !== "checking") {
                    throw new Error(`the check answered ${opened.status}`);
                }

                const { token } = opened;
                const ids = [...opened.unfilledIds];
                // A retry of the same request: while the first continuation waits on its read, the retry and the calls after
                // it run the check to its end.
                const runAhead = async (): Promise<void> => {
                    for (;;) {
                        const answer = await checkEmailCanonicalPage(counted(ctx).ctx, { pageRows: 1, pages: 1, token });

                        if (answer.status !== "checked" && answer.status !== "checking") {
                            throw new Error(`the check answered ${answer.status}`);
                        }

                        ids.push(...answer.unfilledIds);

                        if (answer.status === "checked") {
                            return;
                        }
                    }
                };
                let ranAhead = false;
                const late = await checkEmailCanonicalPage(
                    counted(ctx, {
                        [pausePoint]: async (method?: string) => {
                            if (ranAhead || (onlyMethod !== undefined && method !== onlyMethod)) {
                                return;
                            }

                            ranAhead = true;
                            await runAhead();
                        },
                    }).ctx,
                    { pageRows: 1, pages: 1, token },
                );
                const fills = [];

                for (const id of ids) {
                    const { filled } = await fillEmailCanonicalBatch(counted(ctx).ctx, { ids: [id], token });

                    fills.push(filled);
                }

                return { fill: fills, paused: ranAhead, rows: await canonicals(ctx), stale: late };
            });

            expect(paused).toBe(true);
            expect(stale).toStrictEqual({ scanned: 0, status: "checked", superseded: true, token: expect.any(String), unfilledIds: [] });
            expect(fill).toStrictEqual([1, 1, 1]);
            expect(rows.every(([email, canonical]) => canonical === canonicalEmail(email))).toBe(true);
        },
    );

    it("carries a cursor longer than 512 characters from one check call to the next", async () => {
        expect.assertions(2);

        const { rows, run } = await withHarness(async (ctx) => {
            for (let index = 0; index < 5; index += 1) {
                await ctx.db.insert("user", userRow(`long${String(index)}@example.com`));
            }

            const result = await runBackfill(ctx, { longCursors: true, pageRows: 2, pages: 1 });

            return { rows: await canonicals(ctx), run: result };
        });

        expect(run.exitCode).toBe(0);
        expect(rows.every(([email, canonical]) => canonical === canonicalEmail(email))).toBe(true);
    });

    it("reads each row a bounded number of times over a whole run, and a fill call only its row", async () => {
        expect.assertions(2);

        const total = 12;
        const run = await withHarness(async (ctx) => {
            for (let index = 0; index < total; index += 1) {
                await ctx.db.insert("user", userRow(`reader${String(index).padStart(2, "0")}@example.com`));
            }

            return await runBackfill(ctx);
        });

        expect(run.exitCode).toBe(0);
        // The first read, the check, every row once by id, and the closing check's one read; no rescan per call.
        expect(run.totals.rowsRead).toBeLessThanOrEqual(2 * total + 2);
    });

    describe("a fill is bound to a completed check", () => {
        it("refuses a fill under a token no check made, and writes nothing", async () => {
            expect.assertions(2);

            const { code, rows } = await withHarness(async (ctx) => {
                await ctx.db.insert("user", userRow("lone@example.com"));

                const id = await userIdOf(ctx, "lone@example.com");

                return {
                    code: await refusal(fillEmailCanonicalBatch(counted(ctx).ctx, { ids: [id], token: "no-check-made-this-token" })),
                    rows: await canonicals(ctx),
                };
            });

            expect(code).toBe("BAD_REQUEST");
            expect(rows).toStrictEqual([["lone@example.com", undefined]]);
        });

        it("refuses a fill from a check that has not read the whole table yet", async () => {
            expect.assertions(2);

            const { code, rows } = await withHarness(async (ctx) => {
                for (let index = 0; index < 3; index += 1) {
                    await ctx.db.insert("user", userRow(`half${String(index)}@example.com`));
                }

                const first = await checkEmailCanonicalPage(counted(ctx).ctx, { pageRows: 1, pages: 1 });

                if (first.status !== "checking") {
                    throw new Error(first.status);
                }

                return {
                    code: await refusal(fillEmailCanonicalBatch(counted(ctx).ctx, { ids: first.unfilledIds, token: first.token })),
                    rows: await canonicals(ctx),
                };
            });

            expect(code).toBe("BAD_REQUEST");
            expect(rows.every(([, canonical]) => canonical === undefined)).toBe(true);
        });

        it("refuses an id the check did not record, also one another check recorded, and writes nothing", async () => {
            expect.assertions(3);

            const { code, filled, rows } = await withHarness(async (ctx) => {
                await ctx.db.insert("user", userRow("checked@example.com"));

                const { token } = await completedCheck(ctx);
                const late = await ctx.db.insert("user", userRow("late@example.com"));
                const other = await completedCheck(ctx);
                const refused = await refusal(fillEmailCanonicalBatch(counted(ctx).ctx, { ids: [late], token }));
                const afterRefusal = await canonicals(ctx);

                return { code: refused, filled: await fillEmailCanonicalBatch(counted(ctx).ctx, { ids: [late], token: other.token }), rows: afterRefusal };
            });

            expect(code).toBe("BAD_REQUEST");
            expect(rows).toContainEqual(["late@example.com", undefined]);
            // The check that recorded it fills it.
            expect(filled).toMatchObject({ filled: 1 });
        });

        it("refuses a check record whose start time lies in the future", async () => {
            expect.assertions(2);

            const { code, rows } = await withHarness(async (ctx) => {
                await ctx.db.insert("user", userRow("future@example.com"));

                const { ids, token } = await completedCheck(ctx);
                const claim = await ctx.db
                    .query("idempotencyClaims")
                    .withIndex("by_scope_key", (q: any) => q.eq("scope", EMAIL_CANONICAL_CHECK_SCOPE).eq("key", token))
                    .first();

                await ctx.db.patch("idempotencyClaims", claim._id, { result: JSON.stringify({ ...JSON.parse(claim.result), startedAt: NOW + 1 }) });

                return { code: await refusal(fillEmailCanonicalBatch(counted(ctx).ctx, { ids, token })), rows: await canonicals(ctx) };
            });

            expect(code).toBe("BAD_REQUEST");
            expect(rows).toStrictEqual([["future@example.com", undefined]]);
        });

        it("refuses to go on with a check under a token it does not know, or one already complete", async () => {
            expect.assertions(2);

            const codes = await withHarness(async (ctx) => {
                await ctx.db.insert("user", userRow("again@example.com"));

                const { token } = await completedCheck(ctx);

                return [
                    await refusal(checkEmailCanonicalPage(counted(ctx).ctx, { token: "no-check-knows-this-token" })),
                    await refusal(checkEmailCanonicalPage(counted(ctx).ctx, { token })),
                ];
            });

            expect(codes[0]).toBe("BAD_REQUEST");
            expect(codes[1]).toBe("BAD_REQUEST");
        });

        it("drops the check record when the check finds a shared address, so no fill can follow it", async () => {
            expect.assertions(1);

            const claims = await withHarness(async (ctx) => {
                await ctx.db.insert("user", userRow("Lee@Example.com"));
                await ctx.db.insert("user", userRow("lee@example.com"));
                await checkEmailCanonicalPage(counted(ctx).ctx);

                return await ctx.db.query("idempotencyClaims").collect();
            });

            expect(claims.filter((claim: { scope: string }) => claim.scope === EMAIL_CANONICAL_CHECK_SCOPE)).toStrictEqual([]);
        });
    });

    it("leaves a row changed since the check began, and fills it in a later round once it settled", async () => {
        expect.assertions(4);

        const { first, later, retried, rows } = await withHarness(async (ctx) => {
            await ctx.db.insert("user", userRow("old@example.com"));
            await ctx.db.insert("user", userRow("Fresh@example.com", { updatedAt: NOW - EMAIL_CANONICAL_SETTLE_MS + 1 }));

            const { token } = await completedCheck(ctx);
            const answers = [];

            for (const email of ["old@example.com", "Fresh@example.com"]) {
                answers.push(await fillEmailCanonicalBatch(counted(ctx).ctx, { ids: [await userIdOf(ctx, email)], token }));
            }

            const afterFirst = await canonicals(ctx);
            // A later round: the same row, checked again once the clock passed its settle window.
            const clock = { now: NOW + 1 };
            const again = await completedCheck(ctx, clock);

            return {
                first: answers,
                later: await fillEmailCanonicalBatch(counted(ctx, clock).ctx, again),
                retried: await canonicals(ctx),
                rows: afterFirst,
            };
        });

        expect(first).toStrictEqual([
            { conflicts: 0, filled: 1, processed: 1, skipped: 0, status: "progress" },
            { conflicts: 0, filled: 0, processed: 1, skipped: 1, status: "progress" },
        ]);
        expect(rows).toStrictEqual([
            ["Fresh@example.com", undefined],
            ["old@example.com", "old@example.com"],
        ]);

        expect(later).toStrictEqual({ conflicts: 0, filled: 1, processed: 1, skipped: 0, status: "progress" });
        expect(retried).toStrictEqual([
            ["Fresh@example.com", "fresh@example.com"],
            ["old@example.com", "old@example.com"],
        ]);
    });

    it("fills an account better-auth wrote, whose dates D1 holds as ISO strings, and stores those dates as epoch ms", async () => {
        expect.assertions(4);

        const createdAt = "2026-11-05T10:00:56.180Z";
        const { audited, rows, run, stored } = await withHarness(async (ctx) => {
            const id = await ctx.db.insert("user", userRow("Signed.Up@Example.com"));

            // Lunora validates the whole row on any patch, so on `main` this answered `VALIDATION_ERROR`, as staging did.
            storeDatesAsText("Signed.Up@Example.com", { banExpires: createdAt, createdAt, updatedAt: createdAt });

            const result = await runBackfill(ctx);
            const { page } = await ctx.db.documentHistory.findMany({ where: { documentId: id, tableName: "user" } });

            return { audited: page.length, rows: await canonicals(ctx), run: result, stored: await ctx.db.get("user", id) };
        });

        expect({ exitCode: run.exitCode, output: run.output }).toMatchObject({ exitCode: 0 });
        expect(rows).toStrictEqual([["Signed.Up@Example.com", "signed.up@example.com"]]);
        expect(stored).toMatchObject({ banExpires: Date.parse(createdAt), createdAt: Date.parse(createdAt), updatedAt: Date.parse(createdAt) });
        // The insert and the fill: the audit trigger ran on the converted row.
        expect(audited).toBe(2);
    });

    it("skips an ISO-dated row whose updatedAt changes between the fill's read and its write", async () => {
        expect.assertions(2);

        const { result, stored } = await withHarness(async (ctx) => {
            const id = await ctx.db.insert("user", userRow("Lena@example.com"));

            storeDatesAsText("Lena@example.com");

            const { ids, token } = await completedCheck(ctx);

            return {
                result: await fillEmailCanonicalBatch(
                    counted(ctx, {
                        patchIf: async () => {
                            storeDatesAsText("Lena@example.com", { updatedAt: "2026-11-05T10:00:56.180Z" });
                        },
                    }).ctx,
                    { ids, token },
                ),
                stored: await ctx.db.get("user", id),
            };
        });

        expect(result).toMatchObject({ filled: 0, skipped: 1, status: "progress" });
        expect(stored).toMatchObject({ updatedAt: "2026-11-05T10:00:56.180Z" });
    });

    it("skips a row whose numeric updatedAt better-auth turns into an ISO string between the fill's read and its write", async () => {
        expect.assertions(2);

        const { result, stored } = await withHarness(async (ctx) => {
            const id = await ctx.db.insert("user", userRow("Mira@example.com"));
            const { ids, token } = await completedCheck(ctx);

            return {
                result: await fillEmailCanonicalBatch(
                    counted(ctx, {
                        patchIf: async () => {
                            storeDatesAsText("Mira@example.com", { updatedAt: "2026-11-05T10:00:56.180Z" });
                        },
                    }).ctx,
                    { ids, token },
                ),
                stored: await ctx.db.get("user", id),
            };
        });

        expect(result).toMatchObject({ filled: 0, skipped: 1, status: "progress" });
        expect(stored).toMatchObject({ updatedAt: "2026-11-05T10:00:56.180Z" });
    });

    it("skips a row whose email changes between the fill's read and its write, and fills nothing for it", async () => {
        expect.assertions(2);

        const { result, rows } = await withHarness(async (ctx) => {
            await ctx.db.insert("user", userRow("Lena@example.com"));

            const { ids, token } = await completedCheck(ctx);

            return {
                result: await fillEmailCanonicalBatch(
                    counted(ctx, {
                        patchIf: async (inner: any, id: string) => {
                            await inner.db.patch("user", id, { email: "other@example.com" });
                        },
                    }).ctx,
                    { ids, token },
                ),
                rows: await canonicals(ctx),
            };
        });

        expect(result).toMatchObject({ filled: 0, skipped: 1, status: "progress" });
        expect(rows).toStrictEqual([["other@example.com", undefined]]);
    });

    it("leaves an ISO-dated row changed inside the settle window, and one whose change time no clock reads", async () => {
        expect.assertions(2);

        const fillOne = async (storedDates: "iso" | "unreadable") =>
            await withHarness(async (ctx) => {
                await ctx.db.insert("user", userRow("old@example.com"));
                await ctx.db.insert("user", userRow("fresh@example.com", { updatedAt: NOW - EMAIL_CANONICAL_SETTLE_MS + 1 }));

                for (const email of ["old@example.com", "fresh@example.com"]) {
                    storeDatesAsText(email, storedDates === "iso" ? {} : { createdAt: "not a date", updatedAt: "not a date" });
                }

                const { token } = await completedCheck(ctx);
                const answers = [];

                for (const email of ["old@example.com", "fresh@example.com"]) {
                    answers.push(await fillEmailCanonicalBatch(counted(ctx).ctx, { ids: [await userIdOf(ctx, email)], token }));
                }

                return answers.map(({ filled, skipped }) => {
                    return { filled, skipped };
                });
            });

        expect(await fillOne("iso")).toStrictEqual([
            { filled: 1, skipped: 0 },
            { filled: 0, skipped: 1 },
        ]);
        // A stored time that does not parse is never taken for settled.
        expect(await fillOne("unreadable")).toStrictEqual([
            { filled: 0, skipped: 1 },
            { filled: 0, skipped: 1 },
        ]);
    });

    it("refuses a settled row whose createdAt no clock reads, rather than store another time for it", async () => {
        expect.assertions(2);

        const { code, rows } = await withHarness(async (ctx) => {
            await ctx.db.insert("user", userRow("old@example.com"));
            storeDatesAsText("old@example.com", { createdAt: "not a date" });

            const { ids, token } = await completedCheck(ctx);

            return { code: await refusal(fillEmailCanonicalBatch(counted(ctx).ctx, { ids, token })), rows: await canonicals(ctx) };
        });

        expect(code).toBe("BAD_REQUEST");
        expect(rows).toStrictEqual([["old@example.com", undefined]]);
    });

    it("charges every round of a contended conditional patch, and a fill call still fits the 50 statements", async () => {
        expect.assertions(3);

        const spent = await withHarness(async (ctx) => {
            const outcomes: { error?: string; filled?: number; statements: number }[] = [];

            for (const [email, options] of [
                // Applies on the last round it may take.
                ["late@example.com", { patchRounds: PATCH_IF_ATTEMPTS - 1 }],
                // Loses every round: `occ`, then the holder lookup.
                ["lost@example.com", { patchRounds: PATCH_IF_ATTEMPTS }],
                // Applies on the last round, then the audit insert fails: the holder lookup too.
                [
                    "audited@example.com",
                    {
                        afterPatchIf: () => {
                            throw new Error("audit write failed");
                        },
                        patchRounds: PATCH_IF_ATTEMPTS - 1,
                    },
                ],
            ] as const) {
                await ctx.db.insert("user", userRow(email));

                const { token } = await completedCheck(ctx);
                const id = await userIdOf(ctx, email);
                const run = counted(ctx, options);

                try {
                    const answer = await fillEmailCanonicalBatch(run.ctx, { ids: [id], token });

                    outcomes.push({ filled: answer.filled, statements: run.spent.statements });
                } catch (error) {
                    outcomes.push({ error: (error as Error).message, statements: run.spent.statements });
                }
            }

            return outcomes;
        });

        const rounds = 2 * (PATCH_IF_ATTEMPTS - 1);

        // The row by id and the holder check, then the patch's rounds: applied with its audit insert; lost every round; applied
        // with its audit insert, which failed. Neither failure is a unique violation, so neither looks up a holder.
        expect(spent).toStrictEqual([
            { filled: 1, statements: 2 + rounds + 1 },
            { error: expect.stringContaining("lost the row to concurrent writes"), statements: 2 + 2 * PATCH_IF_ATTEMPTS },
            { error: "audit write failed", statements: 2 + rounds + 1 },
        ]);
        expect(Math.max(...spent.map(({ statements }) => statements))).toBeLessThanOrEqual(EMAIL_CANONICAL_FILL_WORST);
        expect(EMAIL_CANONICAL_FILL_WORST).toBeLessThanOrEqual(INVOCATION_D1_QUERIES);
    });

    it("answers a conflict, not an error, when a sign-up takes an address between the check and the write", async () => {
        expect.assertions(2);

        const { result, rows } = await withHarness(async (ctx) => {
            await ctx.db.insert("user", userRow("FRANK@example.com"));

            const { ids, token } = await completedCheck(ctx);

            await ctx.db.insert("user", userRow("frank@example.com", { emailCanonical: "frank@example.com" }));

            return {
                result: await fillEmailCanonicalBatch(counted(ctx, { hideHolders: true }).ctx, { ids, token }),
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

            const { ids, token } = await completedCheck(ctx);
            const outcomes: string[] = [];

            // The write lands, then the audit insert fails: the holder is the row itself.
            await fillEmailCanonicalBatch(
                counted(ctx, {
                    afterPatchIf: () => {
                        throw new Error("audit write failed");
                    },
                }).ctx,
                { ids: [ids[0]!], token },
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
                { ids: [ids[1]!], token },
            ).catch((error: unknown) => {
                outcomes.push((error as Error).message);
            });

            // Another account takes the address after the holder check, while the write fails for its own reason: still not
            // a duplicate.
            try {
                const result = await fillEmailCanonicalBatch(
                    counted(ctx, {
                        patchIf: async () => {
                            const { email } = (await ctx.db.get("user", ids[1]!))!;

                            await ctx.db.insert("user", userRow(email.toUpperCase(), { emailCanonical: email.toLowerCase() }));

                            throw new Error("D1 overloaded");
                        },
                    }).ctx,
                    { ids: [ids[1]!], token },
                );

                outcomes.push(result.status);
            } catch (error) {
                outcomes.push((error as Error).message);
            }

            return outcomes;
        });

        expect(failures).toStrictEqual(["audit write failed", "D1 unavailable", "D1 overloaded"]);
    });

    it("reads a check page and a fill's row through an index, never sorting the unfilled rows", async () => {
        expect.assertions(2);

        const plans = await withHarness(async (ctx) => {
            for (let index = 0; index < 3; index += 1) {
                await ctx.db.insert("user", userRow(`planned${String(index)}@example.com`));
            }

            const checkRun = counted(ctx);
            const checked = await checkEmailCanonicalPage(checkRun.ctx, { pageRows: 1, pages: 3 });
            // The page the check read after the first, from a cursor.
            const continued = checkRun.spent.queries.find((query) => (query as { cursor?: unknown }).cursor !== undefined);

            if (checked.status !== "checked" || continued === undefined) {
                throw new Error("the check did not read a continued page");
            }

            const fillRun = counted(ctx);

            await fillEmailCanonicalBatch(fillRun.ctx, { ids: [checked.unfilledIds[0]!], token: checked.token });

            const plan = async (query: unknown): Promise<string> => ((await ctx.db.explain("user", query)) as { plan: string[] }).plan.join(" | ");

            return { check: await plan(continued), fill: await plan(fillRun.spent.queries[0]) };
        });

        // A keyset seek on the creation index, and a primary-key search whose sort covers the batch alone.
        expect(plans.check).toMatch(CREATION_INDEX_SEEK);
        expect(plans.fill).toMatch(PRIMARY_KEY_SEARCH);
    });

    it("answers one of two continuations run side by side through the registered mutation as superseded, with no ids", async () => {
        expect.assertions(2);

        const answers = await withHarness(async (ctx) => {
            // More rows than one call reads, so the check is still open after its first call.
            for (let index = 0; index <= EMAIL_CANONICAL_CHECK_PAGES * EMAIL_CANONICAL_CHECK_ROWS; index += 1) {
                await ctx.db.insert("user", userRow(`side${String(index)}@example.com`));
            }

            const opened = await ctx.runMutation(checkEmailCanonical, {});

            return await Promise.all([
                ctx.runMutation(checkEmailCanonical, { token: opened.token }),
                ctx.runMutation(checkEmailCanonical, { token: opened.token }),
            ]);
        });

        expect(answers.filter((answer: { superseded?: boolean }) => answer.superseded === true)).toStrictEqual([
            { scanned: 0, status: "checked", superseded: true, token: expect.any(String), unfilledIds: [] },
        ]);
        expect(answers.find((answer: { superseded?: boolean }) => answer.superseded !== true)).toMatchObject({ scanned: 1, status: "checked" });
    });

    it("runs through the registered mutations, whose output validators take every answer", async () => {
        expect.assertions(4);

        const answers = await withHarness(async (ctx) => {
            await ctx.db.insert("user", userRow("Ivy@example.com", { updatedAt: Date.now() - 2 * EMAIL_CANONICAL_SETTLE_MS }));
            await ctx.db.insert("user", userRow("kept@example.com", { emailCanonical: "kept@example.com" }));

            const checked = await ctx.runMutation(checkEmailCanonical, {});
            const filled = await ctx.runMutation(fillEmailCanonical, { ids: checked.unfilledIds, token: checked.token });
            const done = await ctx.runMutation(checkEmailCanonical, {});

            await ctx.db.insert("user", userRow("JOE@example.com"));
            await ctx.db.insert("user", userRow("joe@example.com"));

            return { checked, conflict: await ctx.runMutation(checkEmailCanonical, {}), done, filled };
        });

        expect(answers.checked).toMatchObject({ scanned: 2, status: "checked" });
        expect(answers.filled).toStrictEqual({ conflicts: 0, filled: 1, processed: 1, skipped: 0, status: "progress" });
        expect(answers.done).toStrictEqual({ status: "done" });
        expect(answers.conflict).toStrictEqual({ conflicts: 1, status: "conflict" });
    });
});
