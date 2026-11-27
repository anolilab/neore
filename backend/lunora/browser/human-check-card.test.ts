/**
 * The "Needs you" card's answer: who may read and answer an ask, that an answer is given once (also by two answers at
 * once), that a decline stops the next ask on the site, and how the agent's `wait_for_person` ends.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { createThreadAccess, deleteThreadAccess, updateThreadAccess } from "../agent/sharing";
import { approveToolCallFor } from "../agent/client/tool-approval";
import { setRunReplyKey } from "../chat/lib/agent-run";
import browserTool, { browserRunKey, waitForAnswer, withAnswer } from "../chat/tools/browser";
import schema from "../schema";
import { claimHumanCheckAsk, humanCheckAnswer } from "./functions";
import { HUMAN_CHECK_ANSWER_WAIT_MS, HUMAN_CHECK_HAND_BACK_WINDOW_MS, humanCheckMessages } from "./human-check";
import { getHumanCheck, resolveHumanCheck } from "./human-check-card";

const OWNER = "user-owner";
const READER = "user-reader";
const STRANGER = "user-stranger";
const WRITER = "user-writer";
const NOW = Date.UTC(2026, 10, 22, 12);
/** No ask the caller may read: the server's clock and nothing else. */
const NO_CHECK = { kind: "none", now: expect.any(Number) };
const GRANT_ENDS = NOW + 30 * 60_000;

const { impersonation, loggedDb, reads, registry, sessionFrom } = vi.hoisted(() => {
    const state: { by?: string } = {};
    const readLog: { log: { by: "id" | "index"; fields?: Record<string, unknown>; index?: string; table: string }[] | undefined } = { log: undefined };
    /** `target`'s member `key`, bound to it when a method, so a wrapper passes everything else through unchanged. */
    const member = (target: any, key: string | symbol): unknown => {
        const value = target[key];

        return typeof value === "function" ? value.bind(target) : value;
    };
    /** An index range builder whose `eq` bounds land in `fields`. */
    const watchedRange = (range: any, fields: Record<string, unknown>): any => {
        const eq = (field: string, bound: unknown): any => {
            fields[field] = bound;

            return watchedRange(range.eq(field, bound), fields);
        };

        return new Proxy(range, { get: (target: any, key: string | symbol) => (key === "eq" ? eq : member(target, key)) });
    };
    const loggedQuery = (query: any, table: string): any =>
        new Proxy(query, {
            get: (target: any, key: string | symbol) => {
                if (key !== "withIndex") {
                    return member(target, key);
                }

                return (name: string, build: (q: any) => unknown) => {
                    const fields: Record<string, unknown> = {};

                    readLog.log?.push({ by: "index", fields, index: name, table });

                    return target.withIndex(name, (q: any) => build(watchedRange(q, fields)));
                };
            },
        });
    const logged = (db: any): any =>
        new Proxy(db, {
            get: (target: any, key: string | symbol) => {
                if (key === "get") {
                    return async (table: string, id: unknown) => {
                        readLog.log?.push({ by: "id", table });

                        return await target.get(table, id);
                    };
                }

                return key === "query" ? (table: string) => loggedQuery(target.query(table), table) : member(target, key);
            },
        });

    return {
        impersonation: state,
        /** Wraps the database the card reads past row-level security with. */
        loggedDb: logged,
        /** While set, what the card's reads past row-level security touch: by-id reads, and each index range's `eq` bounds. */
        reads: readLog,
        registry: new Map<string, unknown>(),
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId
                ? { activeOrganization: null, id: context.auth.userId, impersonatedBy: state.by, isAdmin: false, userId: context.auth.userId }
                : null,
    };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

/** The real `systemDb`, its by-id reads and index ranges logged while `reads.log` is set (`loggedDb`). */
vi.mock("../lib/rls/scope", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../lib/rls/scope")>();

    return { ...actual, systemDb: (ctx: any) => loggedDb(actual.systemDb(ctx)) };
});

// A read replica behind the primary: every grant read that does not ask for the primary gets `replica.grant` while it is
// set (`null`: a replica that has not seen a grant yet). `afterPrimary` runs once after the next primary grant read, as a
// write that commits right after it.
const { replica } = vi.hoisted(() => {
    return { replica: {} as { afterPrimary?: () => Promise<void>; grant?: Record<string, unknown> | null } };
});

vi.mock("../agent/thread-read-access", async (importOriginal) => {
    const original = await importOriginal<typeof import("../agent/thread-read-access")>();
    const lagging = (context: any): any => {
        // The access read takes the grant's live copy from a page of them (`agent/live-grant.ts`).
        const findMany = async (query: { consistency?: string }) => {
            if (query.consistency !== "primary" && replica.grant !== undefined) {
                return { continueCursor: null, isDone: true, page: replica.grant === null ? [] : [replica.grant] };
            }

            const result = await context.db.threadAccess.findMany(query);
            const after = query.consistency === "primary" ? replica.afterPrimary : undefined;

            if (after !== undefined) {
                delete replica.afterPrimary;
                await after();
            }

            return result;
        };
        const db = new Proxy(context.db, {
            get: (target, key) =>
                key === "threadAccess"
                    ? new Proxy(target.threadAccess, {
                          get: (table, name) => (name === "findMany" ? findMany : table[name]),
                      })
                    : target[key],
        });

        return new Proxy(context, { get: (target, key) => (key === "db" ? db : target[key]) });
    };

    return {
        ...original,
        resolveThreadReadAccess: async (context: any, ...rest: Parameters<typeof original.resolveThreadReadAccess> extends [unknown, ...infer R] ? R : never) =>
            await original.resolveThreadReadAccess(lagging(context), ...rest),
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/rate-limiter")>()), rateLimitGuard: async () => undefined };
});

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;

const as = (userId: string) => harness.withIdentity({ userId } as never);
const claim = async (run: string, site: string, thread = threadId): Promise<string | null> =>
    (await harness.action(async (ctx: any) => await ctx.runMutation(claimHumanCheckAsk, { run, site, threadId: thread }))) as string | null;
/** `site` and `run`: the site and reply the browser tool's result names with the ask's id, which the card sends with it. */
const read = async (userId: string, checkId: string, thread = threadId, site = "shop.example", run = "r1"): Promise<any> =>
    await as(userId).query(getHumanCheck as never, { checkId, run, site, threadId: thread } as never);
const resolve = async (userId: string, checkId: string, resolution: "declined" | "done", thread = threadId, site = "shop.example", run = "r1"): Promise<any> =>
    await as(userId).mutation(resolveHumanCheck as never, { checkId, resolution, run, site, threadId: thread } as never);
const row = async (checkId: string): Promise<any> => await harness.run(async (ctx: any) => await ctx.db.get("browserHumanChecks", checkId));

beforeAll(async () => {
    registerModule(registry, "browser_functions", await import("./functions"));
    registerModule(registry, "lib_rate_limiter_mutations", await import("../lib/rate-limiter-mutations"));
}, 30_000);

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    harness = lunoraTest(schema as never);
    threadId = (await harness.run(async (ctx: any) => {
        const id = await ctx.db.insert("threads", { status: "active", title: "T", userId: OWNER });

        await ctx.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "read", threadId: id, userId: READER });
        await ctx.db.insert("threadAccess", { expiresAt: GRANT_ENDS, grantedAt: 0, grantedBy: OWNER, permission: "write", threadId: id, userId: WRITER });

        return id;
    })) as string;
});

afterEach(() => {
    delete replica.grant;
    delete replica.afterPrimary;
    impersonation.by = undefined;
    reads.log = undefined;
    harness.close();
    vi.useRealTimers();
});

describe("the card's read", () => {
    it("shows the site and state, and who may answer it", async () => {
        const checkId = (await claim("r1", "shop.example"))!;

        const expiresAt = NOW + HUMAN_CHECK_HAND_BACK_WINDOW_MS;

        await expect(read(OWNER, checkId)).resolves.toStrictEqual({
            canResolve: true,
            expiresAt,
            kind: "found",
            now: NOW,
            site: "shop.example",
            status: "open",
        });
        // A grantee's card knows when the grant ends: a live answer is not re-read on the clock.
        await expect(read(WRITER, checkId)).resolves.toStrictEqual({
            accessUntil: GRANT_ENDS,
            canResolve: true,
            expiresAt,
            kind: "found",
            now: NOW,
            // The grant's revision this read saw (a grant from before revisions reads as 0); the owner's answer names none.
            revision: 0,
            site: "shop.example",
            status: "open",
        });
        await expect(read(READER, checkId)).resolves.toStrictEqual({
            canResolve: false,
            expiresAt,
            kind: "found",
            now: NOW,
            revision: 0,
            site: "shop.example",
            status: "open",
        });
        await expect(read(STRANGER, checkId)).resolves.toStrictEqual(NO_CHECK);

        impersonation.by = "admin-1";

        await expect(read(OWNER, checkId)).resolves.toMatchObject({ canResolve: false });
    });

    it("refuses a site or a reply key longer than any the browser tool names, before reading anything", async () => {
        const checkId = (await claim("r1", "shop.example"))!;

        await expect(read(OWNER, checkId, threadId, "a".repeat(501))).rejects.toThrow();
        await expect(read(OWNER, checkId, threadId, "shop.example", "r".repeat(1025))).rejects.toThrow();
        await expect(resolve(OWNER, checkId, "done", threadId, "a".repeat(501))).rejects.toThrow();
        await expect(resolve(OWNER, checkId, "done", threadId, "shop.example", "r".repeat(1025))).rejects.toThrow();
        const stored = await row(checkId);

        expect(stored.resolution).toBeUndefined();
    });

    it("says an ask is of another thread only to a full reader of this one, the same as a missing ask, and nothing of a trashed chat", async () => {
        const checkId = (await claim("r1", "shop.example"))!;
        // A branch of the chat: its copied tool result names the parent's ask.
        const other = (await harness.run(async (ctx: any) => {
            const id = await ctx.db.insert("threads", { status: "active", title: "U", userId: OWNER });

            await ctx.db.insert("threadAccess", { expiresAt: GRANT_ENDS, grantedAt: 0, grantedBy: OWNER, permission: "write", threadId: id, userId: WRITER });

            return id;
        })) as string;
        const missing = await harness.run(async (ctx: any) => {
            const id = await ctx.db.insert("browserHumanChecks", { askedAt: NOW, run: "r9", site: "gone.example", threadId: other, userId: OWNER });

            await ctx.db.delete("browserHumanChecks", id);

            return id;
        });

        await expect(read(OWNER, checkId, other)).resolves.toStrictEqual({ kind: "elsewhere", now: NOW });
        await expect(read(OWNER, missing, other)).resolves.toStrictEqual({ kind: "elsewhere", now: NOW });
        await expect(read(WRITER, checkId, other)).resolves.toStrictEqual({ accessUntil: GRANT_ENDS, kind: "elsewhere", now: NOW, revision: 0 });
        // Someone who does not read the branch learns nothing of either thread.
        await expect(read(STRANGER, checkId, other)).resolves.toStrictEqual(NO_CHECK);
        await expect(resolve(OWNER, checkId, "done", other)).rejects.toMatchObject({ code: "FORBIDDEN" });

        await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, { deleted: true }));

        await expect(read(OWNER, checkId)).resolves.toStrictEqual(NO_CHECK);
    });

    it("names a removal's grant revision, higher than the grant's before it, to the reader it removed", async () => {
        const checkId = (await claim("r1", "shop.example"))!;

        await harness.run(async (ctx: any) => {
            const grant = await ctx.db.threadAccess.findFirst({ where: { threadId, userId: READER } });

            await ctx.runMutation(updateThreadAccess, { accessId: grant._id, permission: "read" });
        });
        await expect(read(READER, checkId)).resolves.toMatchObject({ kind: "found", revision: 1 });

        await harness.run(async (ctx: any) => {
            const grant = await ctx.db.threadAccess.findFirst({ where: { threadId, userId: READER } });

            await ctx.runMutation(deleteThreadAccess, { accessId: grant._id });
        });
        await expect(read(READER, checkId)).resolves.toStrictEqual({ ...NO_CHECK, revision: 3 });
        await expect(read(OWNER, checkId)).resolves.not.toHaveProperty("revision");
    });

    it("decides a reader's denial on the primary: a re-grant a replica has not seen yet reads as the grant it is", async () => {
        const checkId = (await claim("r1", "shop.example"))!;

        await harness.run(async (ctx: any) => {
            const grant = await ctx.db.threadAccess.findFirst({ where: { threadId, userId: READER } });

            await ctx.runMutation(deleteThreadAccess, { accessId: grant._id });
            await ctx.runMutation(createThreadAccess, { grantedBy: OWNER, ownerId: OWNER, permission: "read", threadId, userId: READER });
        });

        // A replica that saw the removal but not the grant given again: its denial would name the new grant's revision.
        replica.grant = null;
        await expect(read(READER, checkId)).resolves.toMatchObject({ kind: "found", revision: 3 });
    });

    it("names a denial a revision read after the primary denial: a re-grant and its removal right after it do not leave it older", async () => {
        const checkId = (await claim("r1", "shop.example"))!;

        await harness.run(async (ctx: any) => {
            const grant = await ctx.db.threadAccess.findFirst({ where: { threadId, userId: READER } });

            await ctx.runMutation(deleteThreadAccess, { accessId: grant._id });
        });
        await expect(read(READER, checkId)).resolves.toStrictEqual({ ...NO_CHECK, revision: 2 });

        // The replica already denies; a re-grant and its removal commit right after the primary read denied too.
        replica.afterPrimary = async () =>
            await harness.run(async (ctx: any) => {
                await ctx.runMutation(createThreadAccess, { grantedBy: OWNER, ownerId: OWNER, permission: "read", threadId, userId: READER });

                const grant = await ctx.db.threadAccess.findFirst({ where: { threadId, userId: READER } });

                await ctx.runMutation(deleteThreadAccess, { accessId: grant._id });
            });

        // The re-grant took 3, its removal 4 and 5: the denial names 5, not the 2 a count read before the grant would.
        await expect(read(READER, checkId)).resolves.toStrictEqual({ ...NO_CHECK, revision: 5 });
    });

    it("reads a branch's card through the branch's own asks: the parent's answer is not in its read set and changes nothing", async () => {
        const parentAsk = (await claim("r1", "shop.example"))!;
        // A branch of the chat with an ask of its own on the same site; its copied result names the parent's ask.
        const branch = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "U", userId: OWNER }))) as string;
        const branchAsk = (await claim("r2", "shop.example", branch))!;

        reads.log = [];

        const before = await read(OWNER, parentAsk, branch);
        const touched = reads.log.filter((entry) => entry.table === "browserHumanChecks");

        expect(before).toStrictEqual({ kind: "elsewhere", now: NOW });
        // Never the row by id: one read of the branch's own key for the result's site and reply, so no write to the
        // parent's ask re-runs this query.
        expect(touched).toStrictEqual([
            { by: "index", fields: { run: "r1", site: "shop.example", threadId: branch }, index: "by_threadId_site_run", table: "browserHumanChecks" },
        ]);

        vi.setSystemTime(NOW + 1000);
        await resolve(OWNER, parentAsk, "done");

        await expect(read(OWNER, parentAsk, branch)).resolves.toStrictEqual({ kind: "elsewhere", now: NOW + 1000 });
        await expect(read(OWNER, parentAsk)).resolves.toMatchObject({ kind: "found", status: "done" });
        // The branch's own ask, on the same site, is found by its key; the parent's id under it is not.
        await expect(read(OWNER, branchAsk, branch, "shop.example", "r2")).resolves.toMatchObject({ kind: "found", status: "open" });
        await expect(read(OWNER, parentAsk, branch, "shop.example", "r2")).resolves.toStrictEqual({ kind: "elsewhere", now: NOW + 1000 });
    });

    it("reads one ask's key, however many asks the site had in the chat", async () => {
        const oldest = (await claim("r1", "shop.example"))!;

        for (let index = 0; index < 30; index += 1) {
            await claim(`later-${index}`, "shop.example");
        }

        reads.log = [];

        await expect(read(OWNER, oldest)).resolves.toMatchObject({ kind: "found", status: "open" });
        await expect(resolve(OWNER, oldest, "done")).resolves.toStrictEqual({ changed: true, status: "done" });

        // Every column of the unique key bound, on each read: one row at most, never a walk of the site's asks.
        const range = { by: "index", fields: { run: "r1", site: "shop.example", threadId }, index: "by_threadId_site_run", table: "browserHumanChecks" };

        expect(reads.log.filter((entry) => entry.table === "browserHumanChecks")).toStrictEqual([range, range]);
    });

    it("calls an unanswered ask past the hand-back window expired, and answers nothing on it", async () => {
        const checkId = (await claim("r1", "shop.example"))!;

        vi.setSystemTime(NOW + HUMAN_CHECK_HAND_BACK_WINDOW_MS + 1);

        await expect(read(OWNER, checkId)).resolves.toMatchObject({ canResolve: false, status: "expired" });
        await expect(resolve(OWNER, checkId, "done")).resolves.toStrictEqual({ changed: false, status: "expired" });
        await expect(row(checkId)).resolves.not.toHaveProperty("resolution");
    });
});

describe("the card's answer", () => {
    it("is given by the owner or a writer, never a reader, a stranger or an admin impersonating the owner", async () => {
        const checkId = (await claim("r1", "shop.example"))!;

        await expect(resolve(READER, checkId, "done")).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(resolve(STRANGER, checkId, "done")).rejects.toMatchObject({ code: "FORBIDDEN" });

        impersonation.by = "admin-1";

        await expect(resolve(OWNER, checkId, "done")).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(row(checkId)).resolves.not.toHaveProperty("resolution");

        impersonation.by = undefined;

        await expect(resolve(WRITER, checkId, "done")).resolves.toStrictEqual({ changed: true, status: "done" });
        await expect(row(checkId)).resolves.toMatchObject({ resolution: "done", resolvedAt: NOW, userId: OWNER });
    });

    it("stands once given: a second answer changes nothing and reports the first", async () => {
        const checkId = (await claim("r1", "shop.example"))!;

        await expect(resolve(OWNER, checkId, "declined")).resolves.toStrictEqual({ changed: true, status: "declined" });
        await expect(resolve(OWNER, checkId, "done")).resolves.toStrictEqual({ changed: false, status: "declined" });
        await expect(resolve(WRITER, checkId, "declined")).resolves.toStrictEqual({ changed: false, status: "declined" });
        await expect(row(checkId)).resolves.toMatchObject({ resolution: "declined" });
    });

    it("lets one of two answers sent at once win", async () => {
        const checkId = (await claim("r1", "shop.example"))!;

        const answers = await Promise.all([resolve(OWNER, checkId, "done"), resolve(WRITER, checkId, "declined"), resolve(OWNER, checkId, "declined")]);
        const { resolution: stored } = await row(checkId);

        expect(answers.filter((answer) => answer.changed)).toHaveLength(1);
        expect(answers.every((answer) => answer.status === stored)).toBe(true);
    });
});

describe("after an answer", () => {
    it("asks nobody again in the reply the person declined in, and may ask in a later one", async () => {
        const checkId = (await claim("r1", "shop.example"))!;

        await resolve(OWNER, checkId, "declined");

        await expect(claim("r1", "shop.example")).resolves.toBeNull();
        await expect(claim("r2", "shop.example")).resolves.not.toBeNull();
    });

    it("reads the run's latest ask, or a site's, with its answer", async () => {
        const first = (await claim("r1", "a.example"))!;

        vi.setSystemTime(NOW + 1000);
        await claim("r1", "b.example");
        await claim("r2", "c.example");
        await resolve(OWNER, first, "done", threadId, "a.example");

        const answerOf = async (args: Record<string, unknown>) =>
            await harness.action(async (ctx: any) => await ctx.runQuery(humanCheckAnswer, { askedSince: 0, threadId, ...args }));

        await expect(answerOf({ run: "r1" })).resolves.toStrictEqual({ answer: "open", site: "b.example" });
        await expect(answerOf({ run: "r1", site: "a.example" })).resolves.toStrictEqual({ answer: "done", site: "a.example" });
        await expect(answerOf({ run: "r2", site: "a.example" })).resolves.toBeNull();
        await expect(answerOf({ run: "r9" })).resolves.toBeNull();

        // Many newer asks of other runs in the thread do not hide the run's own.
        vi.setSystemTime(NOW + 2000);

        for (let index = 0; index < 30; index += 1) {
            await claim(`other-${index}`, "d.example");
        }

        await expect(answerOf({ run: "r1" })).resolves.toStrictEqual({ answer: "open", site: "b.example" });
    });
});

/** A tool context whose reads go to the harness, as the agent's do. */
const context = () =>
    ({
        runMutation: async (reference: unknown, args: unknown) => await harness.action(async (ctx: any) => await ctx.runMutation(reference, args)),
        runQuery: async (reference: unknown, args: unknown) => await harness.action(async (ctx: any) => await ctx.runQuery(reference, args)),
    }) as never;

describe("the browser result", () => {
    it("names the card only for an ask this call recorded", async () => {
        const result: any = { error: "asked", humanCheck: { site: "shop.example", status: "asked" }, success: false };

        await withAnswer(context(), threadId as never, "r1", result, new Map([["shop.example", "check-1"]]));
        expect(result.humanCheck).toStrictEqual({ checkId: "check-1", run: "r1", site: "shop.example", status: "asked" });
        // The reply key is the card's, never the model's.
        const forModel = (output: unknown): unknown => (browserTool.toModelOutput as (options: unknown) => unknown).call(browserTool, { output });

        const askForModel = { ...result.humanCheck };

        delete askForModel.run;
        expect(forModel(result)).toStrictEqual(forModel({ ...result, humanCheck: askForModel }));
        expect(JSON.stringify(forModel(result))).not.toContain("r1");

        const other: any = { humanCheck: { site: "other.example", status: "asked" }, success: false };

        await withAnswer(context(), threadId as never, "r1", other, new Map());
        expect(other.humanCheck).not.toHaveProperty("checkId");
    });

    it("tells the agent a site of this reply not asked about again was declined, keeping the rest of its note", async () => {
        const checkId = (await claim("r1", "shop.example"))!;

        await resolve(OWNER, checkId, "declined");

        const result: any = {
            error: `Handed back. ${humanCheckMessages.alreadyAsked("shop.example")}`,
            humanCheck: { site: "shop.example", status: "already_asked" },
            success: false,
        };

        await withAnswer(context(), threadId as never, "r1", result, new Map());

        expect(result).toStrictEqual({
            error: `Handed back. ${humanCheckMessages.answerDeclined("shop.example")}`,
            humanCheck: { site: "shop.example", status: "declined" },
            success: false,
        });

        // A note without the "already asked" text (a hand back still showing the check) gets the decline after it.
        const stillShows: any = { error: "Still shows.", humanCheck: { site: "shop.example", status: "already_asked" }, success: false };

        await withAnswer(context(), threadId as never, "r1", stillShows, new Map());
        expect(stillShows.error).toBe(`Still shows. ${humanCheckMessages.answerDeclined("shop.example")}`);

        // Another reply's decline is not this one's.
        const later: any = { error: "x", humanCheck: { site: "shop.example", status: "already_asked" }, success: false };

        await withAnswer(context(), threadId as never, "r2", later, new Map());
        expect(later.humanCheck.status).toBe("already_asked");

        // A page on the site that looks clear still carries the decline: the card told the person the agent stays off it.
        const clear: any = { success: true, title: "Shop", url: "https://SHOP.example/cart" };

        await withAnswer(context(), threadId as never, "r1", clear, new Map());
        expect(clear).toStrictEqual({
            error: humanCheckMessages.answerDeclined("shop.example"),
            humanCheck: { site: "shop.example", status: "declined" },
            success: true,
            title: "Shop",
            url: "https://SHOP.example/cart",
        });
    });

    it("tells the agent a check the person marked done still shows", async () => {
        const checkId = (await claim("r1", "shop.example"))!;

        await resolve(OWNER, checkId, "done");

        const result: any = {
            error: humanCheckMessages.alreadyAsked("shop.example"),
            humanCheck: { site: "shop.example", status: "already_asked" },
            success: false,
        };

        await withAnswer(context(), threadId as never, "r1", result, new Map());
        expect(result.error).toBe(humanCheckMessages.answerDoneStillShows("shop.example"));

        // A clear page after a done needs no note.
        const clear: any = { success: true, url: "https://shop.example/" };

        await withAnswer(context(), threadId as never, "r1", clear, new Map());
        expect(clear).toStrictEqual({ success: true, url: "https://shop.example/" });
    });

    it("keeps the action's result when the answer cannot be read", async () => {
        const result: any = { error: "x", humanCheck: { site: "shop.example", status: "already_asked" }, screenshot: "png", success: false };
        const failing = {
            runQuery: async () => {
                throw new Error("read failed");
            },
        } as never;

        await expect(withAnswer(failing, threadId as never, "r1", result, new Map())).resolves.toBeUndefined();
        expect(result).toStrictEqual({ error: "x", humanCheck: { site: "shop.example", status: "already_asked" }, screenshot: "png", success: false });
    });

    it("opens no page on a site the person declined in this reply", async () => {
        const checkId = (await claim("r1", "shop.example"))!;

        await resolve(OWNER, checkId, "declined");

        const runAction = vi.fn(async () => {
            return { success: true, url: "https://other.example/" };
        });
        const tool = { ...browserTool, ctx: { ...(context() as object), replyKey: "r1", runAction, threadId, userId: OWNER } } as unknown as {
            execute: (input: { action: string; url?: string }, options: unknown) => Promise<unknown>;
        };
        const options = { messages: [], toolCallId: "call-1" };

        await expect(tool.execute({ action: "navigate", url: "https://shop.example/cart" }, options)).resolves.toStrictEqual({
            error: humanCheckMessages.answerDeclined("shop.example"),
            humanCheck: { site: "shop.example", status: "declined" },
            success: false,
        });
        expect(runAction).not.toHaveBeenCalled();
    });

    it.each(["https://shop.example./x", "https://SHOP.example/x", "https://shop.example../x"])(
        "opens no page on %s once the person declined shop.example",
        async (url) => {
            const checkId = (await claim("r1", "shop.example"))!;

            await resolve(OWNER, checkId, "declined");

            const runAction = vi.fn(async () => {
                return { success: true, url };
            });
            const tool = { ...browserTool, ctx: { ...(context() as object), replyKey: "r1", runAction, threadId, userId: OWNER } } as unknown as {
                execute: (input: { action: string; url?: string }, options: unknown) => Promise<unknown>;
            };

            await expect(tool.execute({ action: "navigate", url }, { messages: [], toolCallId: "call-1" })).resolves.toStrictEqual({
                error: humanCheckMessages.answerDeclined("shop.example"),
                humanCheck: { site: "shop.example", status: "declined" },
                success: false,
            });
            expect(runAction).not.toHaveBeenCalled();
        },
    );

    it.each(["shop.example.", "shop.example.."])("keeps a decline of an ask stored as %s, from before sites lost the dot", async (stored) => {
        const checkId = (await claim("r1", stored))!;

        await resolve(OWNER, checkId, "declined", threadId, stored);

        const runAction = vi.fn(async () => {
            return { success: true, url: "https://shop.example/x" };
        });
        const tool = { ...browserTool, ctx: { ...(context() as object), replyKey: "r1", runAction, threadId, userId: OWNER } } as unknown as {
            execute: (input: { action: string; url?: string }, options: unknown) => Promise<unknown>;
        };

        await expect(tool.execute({ action: "navigate", url: "https://shop.example/x" }, { messages: [], toolCallId: "call-1" })).resolves.toStrictEqual({
            error: humanCheckMessages.answerDeclined("shop.example"),
            humanCheck: { site: "shop.example", status: "declined" },
            success: false,
        });
        expect(runAction).not.toHaveBeenCalled();
        // Nor is the person asked again about it in the reply, and the agent hears the one spelling.
        await expect(claim("r1", "shop.example")).resolves.toBeNull();
        await expect(harness.action(async (ctx: any) => await ctx.runQuery(humanCheckAnswer, { askedSince: 0, run: "r1", threadId }))).resolves.toStrictEqual({
            answer: "declined",
            site: "shop.example",
        });
    });
});

describe("approved continuations", () => {
    /** Approves a pending browser click in a continuation that set `replyKey` as `resumeApprovedRun` does; the run key the tool saw. */
    const approveIn = async (replyKey: string | undefined, toolCallId: string): Promise<string> => {
        let seen: string | undefined;
        const callRow = {
            _creationTime: 11,
            _id: `m-${toolCallId}`,
            message: {
                content: [
                    { input: { action: "click", selector: "#go" }, toolCallId, toolName: "browser", type: "tool-call" },
                    { approvalId: `approval-${toolCallId}`, toolCallId, type: "tool-approval-request" },
                ],
                role: "assistant",
            },
            order: 1,
            status: "success",
            stepOrder: 1,
            threadId,
            tool: false,
        };
        const execute = vi.fn(async function runClick(this: { ctx: object }, _input: unknown, options: { toolCallId: string }) {
            seen = browserRunKey(this.ctx, options.toolCallId);

            return { success: true, url: "https://shop.example/" };
        });
        const agent = {
            getThreadMetadata: vi.fn(async () => {
                return { userId: OWNER };
            }),
            listMessages: vi.fn(async () => {
                return { continueCursor: null, isDone: true, page: [callRow] };
            }),
            options: { tools: { browser: { ...browserTool, execute } } },
            saveMessage: vi.fn(async () => {
                return { messageId: "saved" };
            }),
            streamText: vi.fn(),
        };
        const actionCtx = { runAction: vi.fn(), runMutation: vi.fn(), runQuery: vi.fn(), storage: {} };

        if (replyKey !== undefined) {
            setRunReplyKey(actionCtx, replyKey);
        }

        await approveToolCallFor(agent as never, actionCtx as never, { threadId, userId: OWNER }, { approvalId: `approval-${toolCallId}` });

        return seen!;
    };

    it("ask on a site each in their own reply, so two in one chat each get a card", async () => {
        const first = await approveIn("stream-a", "call-1");
        const second = await approveIn("stream-b", "call-2");

        expect([first, second]).toStrictEqual(["stream-a", "stream-b"]);
        await expect(claim(first, "shop.example")).resolves.toEqual(expect.any(String));
        await expect(claim(second, "shop.example")).resolves.toEqual(expect.any(String));
    });

    it("never fall back to the chat as the reply, so a continuation without a reply key still gets its card", async () => {
        const earlier = await approveIn("stream-a", "call-1");
        const keyless = await approveIn(undefined, "call-2");

        expect(keyless).not.toBe(threadId);
        await expect(claim(earlier, "shop.example")).resolves.toEqual(expect.any(String));
        await expect(claim(keyless, "shop.example")).resolves.toEqual(expect.any(String));
    });
});

describe("wait_for_person", () => {
    it("has nothing to wait for without an ask in the reply", async () => {
        await expect(waitForAnswer(context(), threadId as never, "r1", undefined)).resolves.toStrictEqual({
            error: humanCheckMessages.answerNone,
            success: false,
        });
    });

    it("returns at once with an answer given", async () => {
        const checkId = (await claim("r1", "shop.example"))!;

        await resolve(OWNER, checkId, "done");

        await expect(waitForAnswer(context(), threadId as never, "r1", undefined)).resolves.toStrictEqual({
            result: humanCheckMessages.answerDone("shop.example"),
            success: true,
        });
    });

    it("hears an answer given while it waits", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        vi.setSystemTime(NOW);

        const checkId = (await claim("r1", "shop.example"))!;
        const waiting = waitForAnswer(context(), threadId as never, "r1", undefined);

        await vi.advanceTimersByTimeAsync(5000);
        await resolve(OWNER, checkId, "declined");
        await vi.advanceTimersByTimeAsync(5000);

        await expect(waiting).resolves.toStrictEqual({ error: humanCheckMessages.answerDeclined("shop.example"), success: false });
    });

    it("gives up after its bound, telling the agent to end its reply rather than wait again", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        vi.setSystemTime(NOW);
        await claim("r1", "shop.example");

        const waiting = waitForAnswer(context(), threadId as never, "r1", undefined);

        await vi.advanceTimersByTimeAsync(HUMAN_CHECK_ANSWER_WAIT_MS + 1000);

        await expect(waiting).resolves.toStrictEqual({ error: humanCheckMessages.answerPending("shop.example"), success: false });
        expect(vi.getTimerCount()).toBe(0);
    });

    it("waits once per ask: a second wait answers at once", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        vi.setSystemTime(NOW);
        await claim("r1", "shop.example");

        const first = waitForAnswer(context(), threadId as never, "r1", undefined);

        await vi.advanceTimersByTimeAsync(HUMAN_CHECK_ANSWER_WAIT_MS + 1000);
        await first;

        const startedAt = Date.now();

        await expect(waitForAnswer(context(), threadId as never, "r1", undefined)).resolves.toStrictEqual({
            error: humanCheckMessages.answerPending("shop.example"),
            success: false,
        });
        expect(Date.now()).toBe(startedAt);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps to the ask it began on when the run asks about another site meanwhile", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        vi.setSystemTime(NOW);

        const checkId = (await claim("r1", "a.example"))!;
        const waiting = waitForAnswer(context(), threadId as never, "r1", undefined);

        await vi.advanceTimersByTimeAsync(4000);
        await claim("r1", "b.example");
        await resolve(OWNER, checkId, "declined", threadId, "a.example");
        await vi.advanceTimersByTimeAsync(4000);

        await expect(waiting).resolves.toStrictEqual({ error: humanCheckMessages.answerDeclined("a.example"), success: false });
    });

    it("ends on Stop", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        vi.setSystemTime(NOW);
        await claim("r1", "shop.example");

        const stop = new AbortController();
        const waiting = waitForAnswer(context(), threadId as never, "r1", stop.signal);

        await vi.advanceTimersByTimeAsync(1000);
        stop.abort();

        await expect(waiting).resolves.toStrictEqual({ error: humanCheckMessages.answerStopped, success: false });
    });
});
