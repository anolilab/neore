/**
 * The "Needs you" card's answer: who may read and answer an ask, that an answer is given once (also by two answers at
 * once), that a decline stops the next ask on the site, and how the agent's `wait_for_person` ends.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import browserTool, { waitForAnswer, withAnswer } from "../chat/tools/browser";
import schema from "../schema";
import { claimHumanCheckAsk, humanCheckAnswer } from "./functions";
import { HUMAN_CHECK_ANSWER_WAIT_MS, HUMAN_CHECK_HAND_BACK_WINDOW_MS, humanCheckMessages } from "./human-check";
import { getHumanCheck, resolveHumanCheck } from "./human-check-card";

const OWNER = "user-owner";
const READER = "user-reader";
const STRANGER = "user-stranger";
const WRITER = "user-writer";
const NOW = Date.UTC(2026, 10, 22, 12);
const GRANT_ENDS = NOW + 30 * 60_000;

const { impersonation, registry, sessionFrom } = vi.hoisted(() => {
    const state: { by?: string } = {};

    return {
        impersonation: state,
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

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/rate-limiter")>()), rateLimitGuard: async () => undefined };
});

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;

const as = (userId: string) => harness.withIdentity({ userId } as never);
const claim = async (run: string, site: string, thread = threadId): Promise<string | null> =>
    (await harness.action(async (ctx: any) => await ctx.runMutation(claimHumanCheckAsk, { run, site, threadId: thread }))) as string | null;
const read = async (userId: string, checkId: string, thread = threadId): Promise<any> =>
    await as(userId).query(getHumanCheck as never, { checkId, threadId: thread } as never);
const resolve = async (userId: string, checkId: string, resolution: "declined" | "done", thread = threadId): Promise<any> =>
    await as(userId).mutation(resolveHumanCheck as never, { checkId, resolution, threadId: thread } as never);
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
    impersonation.by = undefined;
    harness.close();
    vi.useRealTimers();
});

describe("the card's read", () => {
    it("shows the site and state, and who may answer it", async () => {
        const checkId = (await claim("r1", "shop.example"))!;

        const expiresAt = NOW + HUMAN_CHECK_HAND_BACK_WINDOW_MS;

        await expect(read(OWNER, checkId)).resolves.toStrictEqual({ canResolve: true, expiresAt, now: NOW, site: "shop.example", status: "open" });
        // A grantee's card knows when the grant ends: a live answer is not re-read on the clock.
        await expect(read(WRITER, checkId)).resolves.toStrictEqual({
            accessUntil: GRANT_ENDS,
            canResolve: true,
            expiresAt,
            now: NOW,
            site: "shop.example",
            status: "open",
        });
        await expect(read(READER, checkId)).resolves.toStrictEqual({ canResolve: false, expiresAt, now: NOW, site: "shop.example", status: "open" });
        await expect(read(STRANGER, checkId)).resolves.toBeNull();

        impersonation.by = "admin-1";

        await expect(read(OWNER, checkId)).resolves.toMatchObject({ canResolve: false });
    });

    it("shows nothing for an ask of another thread, and nothing of a trashed chat", async () => {
        const checkId = (await claim("r1", "shop.example"))!;
        const other = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "U", userId: OWNER }))) as string;

        await expect(read(OWNER, checkId, other)).resolves.toBeNull();
        await expect(resolve(OWNER, checkId, "done", other)).rejects.toMatchObject({ code: "FORBIDDEN" });

        await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, { deleted: true }));

        await expect(read(OWNER, checkId)).resolves.toBeNull();
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
        await resolve(OWNER, first, "done");

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
        expect(result.humanCheck).toStrictEqual({ checkId: "check-1", site: "shop.example", status: "asked" });

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
        await resolve(OWNER, checkId, "declined");
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
