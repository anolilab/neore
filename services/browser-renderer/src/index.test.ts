import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import app from "./index";

/** A browser binding whose `connect` and `launch` answer only when the test says so. */
const binding = () => {
    const pending: ((browser: unknown) => void)[] = [];
    const start = async () =>
        new Promise((resolve) => {
            pending.push(resolve);
        });

    return { env: { BROWSER: { connect: start, launch: start }, NODE_ENV: "test" }, pending };
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
