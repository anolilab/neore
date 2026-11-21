import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import app from "./index";

/** A browser binding whose `connect` and `launch` answer only when the test says so; `started` says which ran. */
const binding = () => {
    const pending: ((browser: unknown) => void)[] = [];
    const started: string[] = [];
    const start = (how: string) => async () =>
        new Promise((resolve) => {
            started.push(how);
            pending.push(resolve);
        });

    return { env: { BROWSER: { connect: start("connect"), launch: start("launch") }, NODE_ENV: "test" }, pending, started };
};

/** A browser whose page cannot be set up: it has no page, and opening one fails. */
const brokenBrowser = (close: () => Promise<void>, sessionId: string) => {
    return {
        close,
        contexts: () => [],
        newPage: async () => {
            throw new Error("no page");
        },
        sessionId: () => sessionId,
    };
};

interface Body {
    action?: string;
    budgetMs?: number;
    origin?: string;
    password?: string;
    sessionId?: string;
    url?: string;
    username?: string;
}

const post = async (env: ReturnType<typeof binding>["env"], path: string, body: Body) =>
    app.request(path, { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" }, env);

const SAVED_SECRET = "s3cret-pw";

const LOGIN = { origin: "https://example.com", password: SAVED_SECRET, url: "https://example.com/login", username: "ann" };

describe("POST /login", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("refuses a budget too short for a sign-in, saying so", async () => {
        const response = await post(binding().env, "/login", { ...LOGIN, budgetMs: 5000 });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toStrictEqual({ error: expect.stringContaining("a sign-in needs at least 20 s"), success: false });
    });

    it("refuses a password too short to keep out of the results, before any browser opens", async () => {
        const { env, pending } = binding();
        const response = await post(env, "/login", { ...LOGIN, password: "abc" });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toStrictEqual({ error: expect.stringContaining("shorter than 4 characters is not filled"), success: false });
        expect(pending).toHaveLength(0);
    });

    it("ends within its budget when the browser does not start, and closes the browser that starts late", async () => {
        const { env, pending } = binding();
        const response = post(env, "/login", { ...LOGIN, budgetMs: 20_000 });

        await vi.advanceTimersByTimeAsync(18_000);

        const answer = await response;

        expect(answer.status).toBe(504);

        const close = vi.fn(async () => undefined);

        pending[0]?.({ close, sessionId: () => "late" });
        await vi.advanceTimersByTimeAsync(0);

        expect(close).toHaveBeenCalledOnce();
    });

    it("leaves the caller's session open when its reconnect is late, and says nothing of it closing", async () => {
        const { env, pending, started } = binding();
        const response = post(env, "/login", { ...LOGIN, budgetMs: 20_000, sessionId: "kept" });

        await vi.advanceTimersByTimeAsync(18_000);

        const answer = await response;

        expect(answer.status).toBe(504);
        await expect(answer.json()).resolves.not.toHaveProperty("sessionClosed");

        const close = vi.fn(async () => undefined);

        expect(started).toStrictEqual(["connect"]);
        pending[0]?.({ close, sessionId: () => "kept" });
        await vi.advanceTimersByTimeAsync(0);

        expect(close).not.toHaveBeenCalled();
    });

    it("closes a browser it launched when its page cannot be set up, but not the caller's reconnected one", async () => {
        const { env, pending } = binding();
        const launchedClose = vi.fn(async () => undefined);
        const launched = post(env, "/login", { ...LOGIN, budgetMs: 20_000 });

        await vi.advanceTimersByTimeAsync(0);
        pending[0]?.(brokenBrowser(launchedClose, "new"));

        const launchedAnswer = await launched;

        expect(launchedAnswer.status).toBe(500);
        expect(launchedClose).toHaveBeenCalledOnce();

        const connectedClose = vi.fn(async () => undefined);
        const connected = post(env, "/login", { ...LOGIN, budgetMs: 20_000, sessionId: "kept" });

        await vi.advanceTimersByTimeAsync(0);
        pending[1]?.(brokenBrowser(connectedClose, "kept"));

        const connectedAnswer = await connected;

        expect(connectedAnswer.status).toBe(500);
        await expect(connectedAnswer.json()).resolves.not.toHaveProperty("sessionClosed");
        expect(connectedClose).not.toHaveBeenCalled();
    });

    it("says the caller's session is closed when its reconnect failed and the browser launched instead cannot be set up", async () => {
        const { env, pending } = binding();

        env.BROWSER.connect = async () => {
            throw new Error("session gone");
        };

        const answer = post(env, "/login", { ...LOGIN, budgetMs: 20_000, sessionId: "gone" });

        await vi.advanceTimersByTimeAsync(0);
        pending[0]?.(brokenBrowser(async () => undefined, "new"));

        const response = await answer;

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toMatchObject({ sessionClosed: true, success: false });
    });

    /** Signs in on `sessionId` with a page whose lock never sets up (its sockets are never gated), so the session must be closed. */
    const mustClose = async (close: () => Promise<void>, sessionId: string) => {
        const { env, pending, started } = binding();
        const context = {
            route: async () => undefined,
            routeWebSocket: async () =>
                new Promise<void>(() => {
                    // Never settles.
                }),
        };
        const page = { close: async () => undefined, context: () => context, setDefaultTimeout: () => undefined, url: () => "about:blank" };
        const response = post(env, "/login", { ...LOGIN, budgetMs: 20_000, sessionId });

        await vi.advanceTimersByTimeAsync(0);
        pending[0]?.({ close, contexts: () => [{ pages: () => [page] }], sessionId: () => sessionId });
        await vi.advanceTimersByTimeAsync(20_000);

        return { answer: await response, env, started };
    };

    /** Whether a call on `sessionId` gets to the browser: one refused as busy never connects. */
    const isFree = async ({ env, started }: Awaited<ReturnType<typeof mustClose>>, sessionId: string): Promise<boolean> => {
        const before = started.length;

        post(env, "/action", { action: "extract", sessionId }).catch(() => undefined);
        await vi.advanceTimersByTimeAsync(0);

        return started.length > before;
    };

    it("says the session is closed once its close is confirmed, and lets go of it", async () => {
        const close = vi.fn(async () => undefined);
        const signedIn = await mustClose(close, "closed");
        const { answer } = signedIn;

        expect(answer.status).toBe(200);
        await expect(answer.json()).resolves.toMatchObject({
            error: expect.stringContaining("so the browser session was closed"),
            sessionClosed: true,
            success: false,
        });
        expect(close).toHaveBeenCalledOnce();
        await expect(isFree(signedIn, "closed")).resolves.toBe(true);
    });

    it("keeps a session whose close ends after the answer held until it ends", async () => {
        const closed = Promise.withResolvers<undefined>();
        const signedIn = await mustClose(async () => closed.promise, "late");

        await expect(signedIn.answer.json()).resolves.toMatchObject({ sessionCloseUnconfirmed: true });
        await expect(isFree(signedIn, "late")).resolves.toBe(false);

        closed.resolve(undefined);

        await expect(isFree(signedIn, "late")).resolves.toBe(true);
    });

    it("answers by the deadline, leaving the margin to the answer, when the close ends only within that margin", async () => {
        const { env, pending } = binding();
        const context = {
            route: async () => undefined,
            routeWebSocket: async () =>
                new Promise<void>(() => {
                    // Never settles.
                }),
        };
        const page = { close: async () => undefined, context: () => context, setDefaultTimeout: () => undefined, url: () => "about:blank" };
        let wasAnswered = false;
        // Past the deadline, within the margin.
        const closedAt = Date.now() + 18_500;
        const response = post(env, "/login", { ...LOGIN, budgetMs: 20_000, sessionId: "slow" }).finally(() => {
            wasAnswered = true;
        });

        await vi.advanceTimersByTimeAsync(0);
        pending[0]?.({
            close: async () =>
                new Promise<void>((resolve) => {
                    setTimeout(resolve, closedAt - Date.now());
                }),
            contexts: () => [{ pages: () => [page] }],
            sessionId: () => "slow",
        });
        // The budget less the margin: the deadline.
        await vi.advanceTimersByTimeAsync(18_000);

        expect(wasAnswered).toBe(true);

        const answer = await response;

        await expect(answer.json()).resolves.toMatchObject({ sessionCloseUnconfirmed: true, success: false });
    });

    it.each([
        [
            "does not end",
            "stalled",
            async () =>
                new Promise<void>(() => {
                    // Never settles.
                }),
        ],
        [
            "fails",
            "failed",
            async () => {
                throw new Error("close failed");
            },
        ],
    ])("answers within its budget when closing a session it must close %s, says it may still be open, and keeps it held", async (_how, sessionId, onClose) => {
        const close = vi.fn(onClose);
        const { answer, env } = await mustClose(close, sessionId);

        expect(answer.status).toBe(200);

        const body: unknown = await answer.json();

        expect(body).toMatchObject({ error: expect.stringContaining("may still be open"), sessionCloseUnconfirmed: true, success: false });
        expect(body).not.toHaveProperty("sessionClosed");
        expect(body).not.toHaveProperty("sessionId");
        expect(close).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(60_000);

        const action = await post(env, "/action", { action: "extract", sessionId });

        expect(action.status).toBe(409);
    });

    it("holds its session alone: an action on it is refused, and a sign-in waits for no running action", async () => {
        const { env } = binding();
        const signingIn = post(env, "/login", { ...LOGIN, budgetMs: 20_000, sessionId: "one" });

        await vi.advanceTimersByTimeAsync(0);

        const action = await post(env, "/action", { action: "extract", sessionId: "one" });

        expect(action.status).toBe(409);

        // An action that never ends: its session stays in use.
        post(env, "/action", { action: "extract", sessionId: "two" }).catch(() => undefined);
        await vi.advanceTimersByTimeAsync(0);

        const login = await post(env, "/login", { ...LOGIN, sessionId: "two" });

        expect(login.status).toBe(409);

        await vi.advanceTimersByTimeAsync(18_000);
        await signingIn;
    });
});
