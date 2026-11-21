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
