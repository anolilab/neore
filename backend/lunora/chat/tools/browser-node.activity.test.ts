/**
 * What a browser action leaves on the thread's session row for the live view: a running browser is held for the
 * renderer call (a slow action must not read as idle), a reaped or closed one is never offered, and the page named is
 * always the current browser's.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../../test/registered-api";
import schema from "../../schema";
import { BROWSER_IDLE_REAP_MS, BROWSER_REAP_MARGIN_MS, browserAliveUntil, CONTROL_IDLE_MS, watchableSessionId } from "../../browser/live-view-logic";
import { logAction } from "../../browser/functions";
import { FETCH_TIMEOUT_LONG_MS } from "../../lib/fetch-timeout";
import { BROWSER_CLOSED_DURING_ACTION, executeBrowserAction, PERSON_HAS_CONTROL } from "./browser-node";

const { registry, renderer } = vi.hoisted(() => {
    return { registry: new Map<string, unknown>(), renderer: vi.fn() };
});

vi.mock("../../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

vi.mock("../../lib/services", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../../lib/services")>()),
        isServiceBound: () => true,
        serviceFetch: () => fetch,
    };
});

vi.mock("@neore/service-sdk/browser-renderer", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("@neore/service-sdk/browser-renderer")>()), browserAction: renderer };
});

const OWNER = "user-owner";
/** The note an action whose browser was replaced gets: look again, at the kept browser on page a. */
const REPLACED_NOTE_FOR_A = /at the same time.*https:\/\/example\.com\/a.*screenshot or extract/su;
/** The frozen clock every test reads, in the code and in the assertions alike. */
const NOW = Date.UTC(2026, 10, 20, 12);

interface SessionRow {
    control?: { by: string; claim: string; ended?: "browser_closed" | "handed_back" | "left"; since: number; until: number };
    currentUrl?: string;
    inUseHolds?: number[];
    lastActivityAt: number;
    providerSessionId?: string;
    source?: string;
    status: string;
}

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;
let sessionId: string;

const row = async (): Promise<SessionRow> => (await harness.run(async (ctx: any) => await ctx.db.get("browserSessions", sessionId))) as SessionRow;

const addSession = async (lastActivityAt: number): Promise<void> => {
    sessionId = (await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("browserSessions", {
                currentUrl: "https://example.com/before",
                lastActivityAt,
                providerSessionId: "s-1",
                source: "browserbase",
                startedAt: lastActivityAt,
                status: "active",
                threadId,
                userId: OWNER,
            }),
    )) as string;
};

const answered = (data: Record<string, unknown>) => {
    return { data, error: undefined, response: { ok: true, status: 200 } };
};

const act = async (action = "navigate"): Promise<unknown> =>
    await harness.action(
        async (ctx: any) => await ctx.runAction(executeBrowserAction, { action, threadId, url: "https://example.com/", userId: OWNER, userTier: "premium" }),
    );

/** Whether the live view would offer the browser while the renderer runs. */
const watchableDuringRun = (): { value?: string } => {
    const seen: { value?: string } = {};

    renderer.mockImplementationOnce(async () => {
        seen.value = watchableSessionId(await row(), Date.now()) ?? "none";

        return answered({ sessionId: "s-1", success: true, url: "https://example.com/after" });
    });

    return seen;
};

beforeAll(async () => {
    registerModule(registry, "browser_functions", await import("../../browser/functions"));
    registerModule(registry, "lib_rate_limiter_mutations", await import("../../lib/rate-limiter-mutations"));
}, 30_000);

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    harness = lunoraTest(schema as never);
    threadId = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId: OWNER }))) as string;
});

afterEach(() => {
    harness.close();
    renderer.mockReset();
    vi.useRealTimers();
});

/** A renderer answer the test releases by hand, once the action is waiting on it. */
const pendingAnswer = () => {
    let release!: (value: unknown) => void;
    let started!: () => void;
    // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- `Promise.withResolvers` needs Node >= 22.11; the configured range starts at 22.0
    const reached = new Promise<void>((resolve) => {
        started = resolve;
    });
    // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- `Promise.withResolvers` needs Node >= 22.11; the configured range starts at 22.0
    const answer = new Promise((resolve) => {
        release = resolve;
    });

    renderer.mockImplementationOnce(async () => {
        started();

        return await answer;
    });

    return { reached, release };
};

describe("a browser action on a running browser", () => {
    it("holds the browser for the whole renderer call, then records the page it left it on", async () => {
        await addSession(NOW - 1000);
        let heldDuring: number[] | undefined;

        renderer.mockImplementationOnce(async () => {
            const during = await row();

            heldDuring = during.inUseHolds;

            return answered({ sessionId: "s-1", success: true, url: "https://example.com/after" });
        });

        await act();

        // The hold covers the renderer's whole deadline, not one idle window from the start.
        expect(heldDuring).toEqual([NOW + FETCH_TIMEOUT_LONG_MS]);
        const after = await row();

        expect(after).toMatchObject({ currentUrl: "https://example.com/after", lastActivityAt: NOW });
        expect(after.inUseHolds).toBeUndefined();
        // Never alive past the window the action just opened at the provider.
        expect(browserAliveUntil(after)).toBe(NOW + BROWSER_IDLE_REAP_MS - BROWSER_REAP_MARGIN_MS);
    });

    it("ends the hold when the renderer fails, without stamping the browser as used", async () => {
        const lastActivityAt = NOW - 1000;

        await addSession(lastActivityAt);
        renderer.mockRejectedValueOnce(new Error("renderer down"));

        await act();

        const after = await row();

        expect(after).toMatchObject({ lastActivityAt });
        expect(after.inUseHolds).toBeUndefined();
    });

    it("stops offering the browser the renderer closed after a blocked redirect, and forgets its page", async () => {
        await addSession(NOW - 1000);
        renderer.mockResolvedValueOnce(answered({ error: "Redirected to blocked URL", success: false }));

        await act();

        const after = await row();

        expect(after.currentUrl).toBeUndefined();
        expect(watchableSessionId(after, NOW)).toBeUndefined();
    });

    it("keeps the page of the same browser when an action reports none", async () => {
        await addSession(NOW - 1000);
        renderer.mockResolvedValueOnce(answered({ sessionId: "s-1", success: true }));

        await act("scroll");

        expect(await row()).toMatchObject({ currentUrl: "https://example.com/before" });
    });
});

describe("two browser actions at once", () => {
    it("keeps the browser a newer action replaced when an older one finishes after it", async () => {
        await addSession(NOW - 1000);
        const older = pendingAnswer();
        const newer = pendingAnswer();

        const olderRun = act("click");

        await older.reached;
        vi.setSystemTime(NOW + 1000);
        const newerRun = act();

        await newer.reached;

        // The newer action replaced the browser and finishes first; the older one answers about the old browser later.
        newer.release(answered({ sessionId: "s-2", success: true, url: "https://example.com/new" }));
        await newerRun;
        vi.setSystemTime(NOW + 2000);
        older.release(answered({ sessionId: "s-1", success: true, url: "https://example.com/old" }));

        // The older action's page is of the replaced browser: the agent is sent to look at the kept one instead.
        expect(await olderRun).toMatchObject({ success: false, url: "https://example.com/new" });

        const after = await row();

        expect(after).toMatchObject({ currentUrl: "https://example.com/new", lastActivityAt: NOW + 1000, providerSessionId: "s-2" });
        expect(after.inUseHolds).toBeUndefined();
        expect(watchableSessionId(after, NOW + 2000)).toBe("s-2");
    });

    it("keeps the page of the action that started later when an older one on the same browser finishes after it", async () => {
        await addSession(NOW - 1000);
        const older = pendingAnswer();
        const newer = pendingAnswer();

        const olderRun = act("click");

        await older.reached;
        vi.setSystemTime(NOW + 1000);
        const newerRun = act();

        await newer.reached;
        newer.release(answered({ sessionId: "s-1", success: true, url: "https://example.com/new" }));
        await newerRun;
        older.release(answered({ sessionId: "s-1", success: true, url: "https://example.com/old" }));
        await olderRun;

        const after = await row();

        // The harness gives every function inside one `harness.action` the `ctx.now` of that call's start, so the older
        // action records its activity at NOW, before the newer one's NOW + 1000: the window does not go back. (When it
        // finishes later than the newer one in production, its own later time is kept: see the `logAction` test below.)
        expect(after).toMatchObject({ currentUrl: "https://example.com/new", lastActivityAt: NOW + 1000, providerSessionId: "s-1" });
        expect(after.inUseHolds).toBeUndefined();
    });

    it("moves the activity to an older action's completion when it finishes last, and never back, keeping the newer page", async () => {
        await addSession(NOW + 1000);
        await harness.run(
            async (ctx: any) => await ctx.db.patch("browserSessions", sessionId, { currentUrl: "https://example.com/new", currentUrlStartedAt: NOW + 1000 }),
        );
        // The older action's completion, written at the clock's time: each `harness.action` starts its own `ctx.now`.
        const olderFinishes = async (): Promise<unknown> =>
            await harness.action(
                async (ctx: any) =>
                    await ctx.runMutation(logAction, {
                        action: "click",
                        currentUrl: "https://example.com/old",
                        sessionId,
                        startedAt: NOW,
                        startedWithProviderSessionId: "s-1",
                        success: true,
                    }),
            );

        // Completed before the newer action's activity (clock skew between isolates): the window stays where it was.
        vi.setSystemTime(NOW + 500);
        await olderFinishes();
        expect(await row()).toMatchObject({ currentUrl: "https://example.com/new", lastActivityAt: NOW + 1000 });

        // Completed after it: the browser was used until then, so the window moves forward; the page stays the newer one's.
        vi.setSystemTime(NOW + 2000);
        await olderFinishes();
        expect(await row()).toMatchObject({ currentUrl: "https://example.com/new", lastActivityAt: NOW + 2000 });
    });

    it("keeps the hold of an action still running when another one fails", async () => {
        await addSession(NOW - 1000);
        const running = pendingAnswer();

        renderer.mockRejectedValueOnce(new Error("renderer down"));

        const runningRun = act();

        await running.reached;
        vi.setSystemTime(NOW + 1000);
        await act("click");

        // The failed action's hold is gone; the running one's is still there, so the browser is still offered.
        const afterFailure = await row();

        expect(afterFailure.inUseHolds).toEqual([NOW + FETCH_TIMEOUT_LONG_MS]);

        running.release(answered({ sessionId: "s-1", success: true, url: "https://example.com/after" }));
        await runningRun;
        const afterBoth = await row();

        expect(afterBoth.inUseHolds).toBeUndefined();
    });
});

describe("two first browser actions at once", () => {
    it("keep one browser row for the thread, the one the live view and the next action both use", async () => {
        const first = pendingAnswer();
        const second = pendingAnswer();

        // Both start before either has created the thread's row.
        const firstRun = act();

        await first.reached;
        const secondRun = act("click");

        await second.reached;
        first.release(answered({ sessionId: "s-a", success: true, url: "https://example.com/a" }));
        await firstRun;
        second.release(answered({ content: "page b", sessionId: "s-b", success: true, title: "B", url: "https://example.com/b" }));
        const secondResult = (await secondRun) as Record<string, unknown>;

        expect(await firstRun).toMatchObject({ sessionId: "s-a", success: true, url: "https://example.com/a" });
        // The second browser is not the one kept: the agent hears that and where the kept browser is, never page b.
        expect(secondResult).toMatchObject({ success: false, url: "https://example.com/a" });
        expect(secondResult.error).toMatch(REPLACED_NOTE_FOR_A);
        expect(Object.keys(secondResult).toSorted((a, b) => a.localeCompare(b))).toEqual(["error", "success", "url"]);
        expect(secondResult.error).not.toContain("example.com/b");

        const rows = (await harness.run(async (ctx: any) => await ctx.db.query("browserSessions").collect())) as SessionRow[];

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ currentUrl: "https://example.com/a", providerSessionId: "s-a", status: "active" });
        const actions = (await harness.run(async (ctx: any) => await ctx.db.query("browserActions").collect())) as unknown[];

        expect(actions).toHaveLength(2);
    });
});

describe("a browser action after the provider reaped the browser", () => {
    it("does not bring the reaped browser back while the renderer replaces it", async () => {
        await addSession(NOW - BROWSER_IDLE_REAP_MS - 1000);
        const seen = watchableDuringRun();

        await act();

        expect(seen.value).toBe("none");
    });

    it("does not hold a browser at the very edge of its reap: the provider may have reaped it already", async () => {
        // Idle 58 s of the 60 s window: the provider may have reaped it before the row was stamped.
        await addSession(NOW - BROWSER_IDLE_REAP_MS + 2000);
        const seen = watchableDuringRun();

        await act();

        expect(seen.value).toBe("none");
    });

    it("never names the reaped browser's page for its replacement", async () => {
        await addSession(NOW - BROWSER_IDLE_REAP_MS - 1000);
        renderer.mockResolvedValueOnce(answered({ sessionId: "s-2", success: true }));

        await act("scroll");

        const after = await row();

        expect(after).toMatchObject({ providerSessionId: "s-2" });
        expect(after.currentUrl).toBeUndefined();
        expect(watchableSessionId(after, NOW)).toBe("s-2");
    });
});

describe("a browser a person took control of", () => {
    const giveControl = async (control: Record<string, unknown>): Promise<void> => {
        await harness.run(
            async (ctx: any) => await ctx.db.patch("browserSessions", sessionId, { control: { by: OWNER, claim: "c-1", since: NOW - 1000, ...control } }),
        );
    };

    it("refuses the agent's action while the person drives it, and never reaches the renderer", async () => {
        await addSession(NOW - 1000);
        await giveControl({ until: NOW + CONTROL_IDLE_MS });

        await expect(act("click")).resolves.toEqual({ error: PERSON_HAS_CONTROL, success: false });
        expect(renderer).not.toHaveBeenCalled();
        // A refused action costs the agent none of its hourly browser actions.
        await expect(harness.run(async (ctx: any) => await ctx.db.query("rateLimits").collect())).resolves.toEqual([]);
        const after = await row();

        expect(after.inUseHolds).toBeUndefined();
    });

    it.each([
        ["handed_back", "handed it back"],
        ["left", "left the live view"],
        ["browser_closed", "the browser they drove was closed or replaced"],
        [undefined, "stopped using it"],
    ])("after it ended (%s), looks at the page instead of acting, and says on which page it is", async (ended, reason) => {
        await addSession(NOW - 1000);
        await giveControl({ ended, until: NOW - 1 });
        renderer.mockResolvedValueOnce(
            answered({ screenshot: "png", screenshotFormat: "png", sessionId: "s-1", success: true, url: "https://example.com/person" }),
        );

        const result = (await act("click")) as Record<string, unknown>;

        // The planned click is not run: a screenshot of the page the person left comes back in its place.
        expect(renderer.mock.calls[0]?.[0]).toMatchObject({ body: { action: "screenshot", sessionId: "s-1" } });
        expect(result).toMatchObject({ screenshot: "png", success: false, url: "https://example.com/person" });
        expect(result.error).toContain(reason);
        expect(result.error).toContain("The browser is now on https://example.com/person.");
        expect(result.error).toContain("Your click action was not run");

        // Told once: the next action runs as asked.
        const after = await row();

        expect(after.control).toBeUndefined();
        renderer.mockResolvedValueOnce(answered({ sessionId: "s-1", success: true, url: "https://example.com/next" }));
        await expect(act("click")).resolves.toEqual({ sessionId: "s-1", success: true, url: "https://example.com/next" });
    });

    it("looks again on the next action when the first look after a hand back failed", async () => {
        await addSession(NOW - 1000);
        await giveControl({ ended: "handed_back", until: NOW - 1 });
        renderer
            .mockResolvedValueOnce(answered({ error: "Timeout", sessionId: "s-1", success: false }))
            .mockResolvedValueOnce(answered({ screenshot: "png", sessionId: "s-1", success: true, url: "https://example.com/person" }));

        await act("click");
        await expect(row()).resolves.toMatchObject({ control: { ended: "handed_back" } });

        const second = (await act("click")) as Record<string, unknown>;

        expect(renderer.mock.calls[1]?.[0]).toMatchObject({ body: { action: "screenshot" } });
        expect(second.error).toContain("Your click action was not run");
        await expect(row()).resolves.not.toHaveProperty("control");
    });

    it("has every action started side by side after a hand back look first", async () => {
        await addSession(NOW - 1000);
        await giveControl({ ended: "left", until: NOW - 1 });
        const first = pendingAnswer();
        const firstRun = act("click");

        await first.reached;
        renderer.mockResolvedValueOnce(answered({ screenshot: "png", sessionId: "s-1", success: true, url: "https://example.com/person" }));
        await act("type");
        first.release(answered({ screenshot: "png", sessionId: "s-1", success: true, url: "https://example.com/person" }));
        await firstRun;

        expect(renderer.mock.calls.map(([request]) => (request as { body: { action: string } }).body.action)).toEqual(["screenshot", "screenshot"]);
    });

    it.each([
        ["browser_closed", "navigate"],
        ["handed_back", "screenshot"],
    ] as const)("after it ended (%s), sends a navigate to the renderer as %s", async (ended, sent) => {
        await addSession(NOW - 1000);
        await giveControl({ ended, until: NOW - 1 });
        renderer.mockResolvedValueOnce(answered({ sessionId: "s-1", success: true, url: "https://example.com/" }));

        const result = (await act("navigate")) as Record<string, unknown>;

        // A closed browser has no page left to look at: the navigate that reopens one runs, and the agent still hears why.
        expect(renderer.mock.calls[0]?.[0]).toMatchObject({ body: { action: sent } });
        expect(result.success).toBe(sent === "navigate");
        expect(result.error).toContain("The person had control of the browser");
        await expect(row()).resolves.not.toHaveProperty("control");
    });

    it("runs a look at the page as asked after a hand back, with the note", async () => {
        await addSession(NOW - 1000);
        await giveControl({ ended: "handed_back", until: NOW - 1 });
        renderer.mockResolvedValueOnce(answered({ content: "text", sessionId: "s-1", success: true, url: "https://example.com/person" }));

        const result = (await act("extract")) as Record<string, unknown>;

        expect(renderer.mock.calls[0]?.[0]).toMatchObject({ body: { action: "extract" } });
        expect(result).toMatchObject({ content: "text", success: true });
        expect(result.error).toContain("Look at this result again before you act.");
    });
});

describe("a browser session closed while an action ran", () => {
    it("still tells the agent of a hand back when the action's result is discarded", async () => {
        await addSession(NOW - 1000);
        await harness.run(
            async (ctx: any) =>
                await ctx.db.patch("browserSessions", sessionId, {
                    control: { by: OWNER, claim: "c-1", ended: "handed_back", since: NOW - 5000, until: NOW - 1 },
                }),
        );
        renderer.mockImplementationOnce(async () => {
            await harness.run(async (ctx: any) => await ctx.db.patch("browserSessions", sessionId, { status: "terminated" }));

            return answered({ sessionId: "s-1", success: true, url: "https://example.com/old" });
        });

        const result = (await act("screenshot")) as { error: string; success: boolean };

        expect(result.success).toBe(false);
        expect(result.error).toContain("The person had control of the browser and handed it back");
        expect(result.error).toContain(BROWSER_CLOSED_DURING_ACTION);
    });

    it("never hands the old action's result to the agent once a new action opened a fresh browser", async () => {
        await addSession(NOW - 1000);
        const older = pendingAnswer();
        const olderRun = act("click");

        await older.reached;
        // The person closes the session; the next action opens a fresh browser on a new row.
        await harness.run(async (ctx: any) => await ctx.db.patch("browserSessions", sessionId, { status: "terminated" }));
        const closedId = sessionId;

        renderer.mockResolvedValueOnce(answered({ sessionId: "s-2", success: true, url: "https://example.com/fresh" }));
        await expect(act()).resolves.toMatchObject({ sessionId: "s-2", success: true });

        older.release(answered({ content: "secret of the old page", sessionId: "s-1", success: true, url: "https://example.com/old" }));

        await expect(olderRun).resolves.toEqual({ error: BROWSER_CLOSED_DURING_ACTION, success: false });

        const rows = (await harness.run(async (ctx: any) => await ctx.db.query("browserSessions").collect())) as (SessionRow & { _id: string })[];
        const fresh = rows.find((candidate) => candidate._id !== closedId);

        expect(fresh).toMatchObject({ currentUrl: "https://example.com/fresh", providerSessionId: "s-2", status: "active" });
        expect(rows.find((candidate) => candidate._id === closedId)).toMatchObject({ currentUrl: "https://example.com/before", status: "terminated" });
    });
});
