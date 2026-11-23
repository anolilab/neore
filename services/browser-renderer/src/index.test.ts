import { connect, launch } from "@cloudflare/playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import app from "./index";
import { signIn } from "./login";
import { SessionLock } from "./session-lock";

/** The fake binding's RPCs, which the real launcher calls: `launch` to start a browser, `connectSession` to reconnect. */
interface FakeBinding {
    connectSession: (sessionId: string) => Promise<unknown>;
    launch: (options: unknown) => Promise<unknown>;
}

// eslint-disable-next-line no-restricted-syntax -- @cloudflare/playwright imports `cloudflare:workers`, which Node cannot load; the Worker takes the launcher from it, not from Env
vi.mock("@cloudflare/playwright", () => {
    return {
        connect: vi.fn(async (endpoint: FakeBinding, sessionId: string) => await endpoint.connectSession(sessionId)),
        launch: vi.fn(async (endpoint: FakeBinding, options: unknown) => await endpoint.launch(options)),
    };
});

// eslint-disable-next-line no-restricted-syntax -- a sign-in that ends right at its deadline cannot be timed through a page; the real `signIn` runs unless a test says otherwise
vi.mock("./login", async (importOriginal) => {
    const original = await importOriginal<typeof import("./login")>();

    return { ...original, signIn: vi.fn(original.signIn) };
});

/**
 * The `SESSION_LOCK` namespace: one `SessionLock` per session id, on storage kept in memory, which every app instance
 * given it shares, as every isolate shares the Durable Objects. `reachable` false has its calls never answer.
 */
const lockNamespace = () => {
    const locks = new Map<string, SessionLock>();
    const control = { reachable: true };
    const storageOf = () => {
        const stored = new Map<string, unknown>();

        return {
            delete: async (key: string) => stored.delete(key),
            get: async (key: string) => stored.get(key),
            put: async (key: string, value: unknown) => {
                stored.set(key, value);
            },
            setAlarm: async () => undefined,
        };
    };
    const namespace = {
        get: (id: string) => {
            return {
                fetch: async (url: string, init: RequestInit) => {
                    if (!control.reachable) {
                        return new Promise<Response>(() => {
                            // Never answers.
                        });
                    }

                    let lock = locks.get(id);

                    if (!lock) {
                        lock = new SessionLock({ storage: storageOf() } as never);
                        locks.set(id, lock);
                    }

                    return lock.fetch(new Request(url, init));
                },
            };
        },
        idFromName: (name: string) => name,
    };

    return { control, namespace };
};

/** A browser binding whose `connectSession` and `launch` answer only when the test says so; `started` says which ran. */
const binding = (lock = lockNamespace()) => {
    const pending: ((browser: unknown) => void)[] = [];
    const started: string[] = [];
    const start = (how: string) => async () =>
        new Promise((resolve) => {
            started.push(how);
            pending.push(resolve);
        });

    return {
        env: { BROWSER: { connectSession: start("connect"), launch: start("launch") }, NODE_ENV: "test", SESSION_LOCK: lock.namespace },
        lock,
        pending,
        started,
    };
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

/** A browser whose page never sets up its lock: the sign-in on it runs until its budget ends. */
const stallingBrowser = (close: () => Promise<void>, sessionId: string) => {
    const context = {
        route: async () => undefined,
        routeWebSocket: async () =>
            new Promise<void>(() => {
                // Never settles.
            }),
    };
    const page = { close: async () => undefined, context: () => context, setDefaultTimeout: () => undefined, url: () => "about:blank" };

    // Reconnected: `close` stands for the browser's own `Browser.close`, which ends the session; `close()` only disconnects.
    return {
        close: async () => undefined,
        contexts: () => [{ pages: () => [page] }],
        newBrowserCDPSession: async () => {
            return { send: close };
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

/** `body` posted to `path` of the Worker, or of `worker`: another instance of it. */
const post = async (env: ReturnType<typeof binding>["env"], path: string, body: Body, worker: typeof app = app) =>
    worker.request(path, { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" }, env);

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

    it("says the caller's session is closed when its reconnect failed and the new browser does not start in time", async () => {
        const env = {
            BROWSER: {
                connectSession: async () => {
                    throw new Error("session gone");
                },
                launch: async () => await new Promise(() => {}),
            },
            NODE_ENV: "test",
            SESSION_LOCK: lockNamespace().namespace,
        };
        const response = post(env as never, "/login", { ...LOGIN, budgetMs: 20_000, sessionId: "gone" });

        await vi.advanceTimersByTimeAsync(18_000);

        const answer = await response;

        expect(answer.status).toBe(504);
        await expect(answer.json()).resolves.toMatchObject({ sessionClosed: true });
    });

    it("says the caller's session is closed when its reconnect failed and launching a new browser fails", async () => {
        const env = {
            BROWSER: {
                connectSession: async () => {
                    throw new Error("session gone");
                },
                launch: async () => {
                    throw new Error("no browsers left");
                },
            },
            NODE_ENV: "test",
            SESSION_LOCK: lockNamespace().namespace,
        };
        const answer = await post(env as never, "/login", { ...LOGIN, budgetMs: 20_000, sessionId: "gone" });

        expect(answer.status).toBe(500);
        await expect(answer.json()).resolves.toMatchObject({ sessionClosed: true });
        // Through the Playwright launcher, never the binding's own methods: it reconnects by id, and launches with a 60 s keep_alive.
        expect(vi.mocked(connect)).toHaveBeenLastCalledWith(env.BROWSER, "gone");
        expect(vi.mocked(launch)).toHaveBeenLastCalledWith(env.BROWSER, { keep_alive: 60_000 });
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

        env.BROWSER.connectSession = async () => {
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
        const response = post(env, "/login", { ...LOGIN, budgetMs: 20_000, sessionId });

        await vi.advanceTimersByTimeAsync(0);
        pending[0]?.(stallingBrowser(close, sessionId));
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

    it("never counts a reconnected session closed because it disconnected: only the browser's own close ends it", async () => {
        const { env, pending } = binding();
        const { contexts } = stallingBrowser(async () => undefined, "kept");
        const disconnect = vi.fn(async () => undefined);
        const response = post(env, "/login", { ...LOGIN, budgetMs: 20_000, sessionId: "kept" });

        await vi.advanceTimersByTimeAsync(0);
        // `close()` resolves, but the browser takes no `Browser.close`: its session may go on with the page.
        pending[0]?.({
            close: disconnect,
            contexts,
            newBrowserCDPSession: async () => {
                throw new Error("no CDP session");
            },
            sessionId: () => "kept",
        });
        await vi.advanceTimersByTimeAsync(20_000);

        const answer = await response;
        const answered = (await answer.json()) as { sessionClosed?: boolean; sessionCloseUnconfirmed?: boolean; success?: boolean };

        expect(answered).toMatchObject({ sessionCloseUnconfirmed: true, success: false });
        expect(answered).not.toHaveProperty("sessionClosed", true);
        expect(disconnect).toHaveBeenCalled();
    });

    it("types nothing, and answers 503, when the lock does not answer the arm a sign-in needs before it starts on the page", async () => {
        const { env, lock, pending } = binding();
        const response = post(env, "/login", { ...LOGIN, budgetMs: 20_000, sessionId: "unarmed" });
        const close = vi.fn(async () => undefined);
        const browser = stallingBrowser(close, "unarmed");
        const pages = vi.spyOn(browser, "contexts");

        await vi.advanceTimersByTimeAsync(0);
        // The session's take was answered; the lock is out of reach from here.
        lock.control.reachable = false;
        pending[0]?.(browser);
        await vi.advanceTimersByTimeAsync(20_000);

        const answer = await response;

        expect(answer.status).toBe(503);
        await expect(answer.json()).resolves.toMatchObject({ error: expect.stringContaining("nothing was typed"), success: false });
        // The page was set up, but nothing was typed: the sign-in never started on it.
        expect(pages).toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
    });

    it("keeps a session whose close ends after the answer held until it ends", async () => {
        const closed = Promise.withResolvers<undefined>();
        const signedIn = await mustClose(async () => closed.promise, "late");

        await expect(signedIn.answer.json()).resolves.toMatchObject({ sessionCloseUnconfirmed: true });
        await expect(isFree(signedIn, "late")).resolves.toBe(false);

        closed.resolve(undefined);
        // The hold is let go of once the close ends, by a call to the lock.
        await vi.advanceTimersByTimeAsync(0);

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
        ["confirms a close that ends quickly", "quick", 200, { sessionClosed: true }],
        ["says a close that does not end quickly may still be open", "slow", 10_000, { sessionCloseUnconfirmed: true }],
    ])("%s for a sign-in that fails right at its deadline, answering within the margin", async (_what, sessionId, closeMs, expected) => {
        vi.mocked(signIn).mockImplementationOnce(async (_page, { deadline }) => {
            await new Promise((resolve) => {
                setTimeout(resolve, deadline - Date.now());
            });

            return { error: "The password could not be cleared from the page in time", sessionClosed: true, submitted: true, success: false };
        });

        const { env, pending } = binding();
        const close = vi.fn(
            async () =>
                new Promise<void>((resolve) => {
                    setTimeout(resolve, closeMs);
                }),
        );
        // The budget: the deadline and the margin after it.
        const answerBy = Date.now() + 20_000;
        let answeredAt = Infinity;
        const response = post(env, "/login", { ...LOGIN, budgetMs: 20_000, sessionId }).finally(() => {
            answeredAt = Date.now();
        });

        await vi.advanceTimersByTimeAsync(0);
        pending[0]?.(stallingBrowser(close, sessionId));
        await vi.advanceTimersByTimeAsync(20_000);

        expect(answeredAt).toBeLessThanOrEqual(answerBy);
        expect(close).toHaveBeenCalledOnce();
        const answer = await response;

        await expect(answer.json()).resolves.toMatchObject({ ...expected, success: false });
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
});

describe("the session hold every isolate shares", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    /** A second instance of the Worker, as another isolate runs it: none of its module state is this one's. */
    const otherIsolate = async () => {
        vi.resetModules();

        const other = await import("./index");

        return other.default;
    };

    it("refuses an action another isolate is asked for while a sign-in holds the session, before it connects", async () => {
        const { env, pending, started } = binding();
        const other = await otherIsolate();
        const signingIn = post(env, "/login", { ...LOGIN, budgetMs: 20_000, sessionId: "shared" });

        await vi.advanceTimersByTimeAsync(0);
        pending[0]?.(stallingBrowser(async () => undefined, "shared"));
        await vi.advanceTimersByTimeAsync(0);

        const action = await post(env, "/action", { action: "extract", sessionId: "shared" }, other);

        expect(action.status).toBe(409);
        await expect(action.json()).resolves.toMatchObject({ error: expect.stringContaining("signing in"), success: false });
        expect(started).toStrictEqual(["connect"]);

        await vi.advanceTimersByTimeAsync(20_000);
        await signingIn;

        // Once the sign-in let go, the other isolate's action runs.
        post(env, "/action", { action: "extract", sessionId: "shared" }, other).catch(() => undefined);
        await vi.advanceTimersByTimeAsync(0);

        expect(started).toStrictEqual(["connect", "connect"]);
    });

    it("refuses a sign-in while another isolate's action holds the session", async () => {
        const { env, started } = binding();
        const other = await otherIsolate();

        // An action that never ends: the session stays in use.
        post(env, "/action", { action: "extract", sessionId: "busy" }, other).catch(() => undefined);
        await vi.advanceTimersByTimeAsync(0);

        const login = await post(env, "/login", { ...LOGIN, sessionId: "busy" });

        expect(login.status).toBe(409);
        expect(started).toStrictEqual(["connect"]);
    });

    it.each([
        ["/login", { ...LOGIN, sessionId: "away" }],
        ["/action", { action: "extract", sessionId: "away" }],
    ])("refuses %s on a session, before it connects, when the lock does not answer", async (path, body) => {
        const { env, lock, started } = binding();

        lock.control.reachable = false;

        const answer = post(env, path, body);

        await vi.advanceTimersByTimeAsync(3000);

        const response = await answer;

        expect(response.status).toBe(503);
        // Nothing ran: the backend gives the action's rate-limit charge back.
        expect(response.headers.get("x-browser-action")).toBe(path === "/action" ? "not-run" : null);
        expect(started).toStrictEqual([]);
    });

    it("keeps an action's result when only the release is slow to answer, its hold intact all along", async () => {
        const { env, lock, pending } = binding();
        const answer = post(env, "/action", { action: "extract", sessionId: "slow" });

        await vi.advanceTimersByTimeAsync(0);
        lock.control.reachable = false;
        pending[0]?.(brokenBrowser(async () => undefined, "slow"));
        await vi.advanceTimersByTimeAsync(3000);

        const response = await answer;

        // The action's own answer (its page could not be set up), not a withheld one.
        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toStrictEqual({ error: "no page", success: false });
    });

    it("stops an action whose hold may lapse, closing its browser before the lease ends, and withholds its result", async () => {
        const { env, lock, pending } = binding();
        const evaluating = Promise.withResolvers<string>();
        const close = vi.fn(async () => {
            evaluating.reject(new Error("Target page, context or browser has been closed"));
        });
        const context = { route: async () => undefined };
        const page = {
            context: () => context,
            evaluate: async () => evaluating.promise,
            setDefaultTimeout: () => undefined,
        };
        const answer = post(env, "/action", { action: "extract", sessionId: "lost" });

        await vi.advanceTimersByTimeAsync(0);
        pending[0]?.({ close, contexts: () => [{ pages: () => [page] }], sessionId: () => "lost" });
        await vi.advanceTimersByTimeAsync(0);
        lock.control.reachable = false;
        // Given up 10 s before the 30 s lease could lapse: a sign-in can take the session only after it (and its drain).
        await vi.advanceTimersByTimeAsync(20_000);

        expect(close).toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(3000);

        const response = await answer;

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toStrictEqual({ error: expect.stringContaining("result is withheld"), success: false });
    });

    it("answers 410 with SESSION_RETIRED, not a busy 409, for a session retired for good", async () => {
        const { env, pending } = binding();
        const lingering = post(env, "/login", { ...LOGIN, budgetMs: 20_000, sessionId: "old" });

        await vi.advanceTimersByTimeAsync(0);
        // A close that never ends: the hold lingers, then lapses, and retires the session.
        pending[0]?.(
            stallingBrowser(
                async () =>
                    new Promise<void>(() => {
                        // Never settles.
                    }),
                "old",
            ),
        );
        await vi.advanceTimersByTimeAsync(20_000);
        await lingering;
        await vi.advanceTimersByTimeAsync(200_000);

        for (const [path, body] of [
            ["/action", { action: "extract", sessionId: "old" }],
            ["/login", { ...LOGIN, sessionId: "old" }],
        ] as const) {
            const response = await post(env, path, body);

            expect(response.status).toBe(410);
            await expect(response.json()).resolves.toMatchObject({ code: "SESSION_RETIRED", success: false });
        }
    });

    it("keeps a sign-in's hold past its answer while a reconnect it gave up on is still setting up", async () => {
        const { env, pending } = binding();
        const signingIn = post(env, "/login", { ...LOGIN, budgetMs: 20_000, sessionId: "late" });

        await vi.advanceTimersByTimeAsync(18_000);

        const answered = await signingIn;
        // The reconnect is still pending: no action reaches the session.
        const refused = await post(env, "/action", { action: "extract", sessionId: "late" });

        expect(answered.status).toBe(504);
        expect(refused.status).toBe(409);

        pending[0]?.(brokenBrowser(async () => undefined, "late"));
        await vi.advanceTimersByTimeAsync(0);

        post(env, "/action", { action: "extract", sessionId: "late" }).catch(() => undefined);
        await vi.advanceTimersByTimeAsync(0);

        expect(pending).toHaveLength(2);
    });

    it("closes the browser when the sign-in's hold can no longer be renewed, before it could lapse, and says the session may be open", async () => {
        const { env, lock, pending } = binding();
        const close = vi.fn(async () => undefined);
        const response = post(env, "/login", { ...LOGIN, budgetMs: 60_000, sessionId: "unrenewed" });

        await vi.advanceTimersByTimeAsync(0);
        pending[0]?.(stallingBrowser(close, "unrenewed"));
        await vi.advanceTimersByTimeAsync(0);
        lock.control.reachable = false;
        // The lease is 30 s from the take: given up 10 s before it.
        await vi.advanceTimersByTimeAsync(19_000);

        expect(close).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1000);

        expect(close).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(40_000);

        const answer = await response;

        await expect(answer.json()).resolves.toMatchObject({
            error: expect.stringContaining("could not be kept"),
            sessionCloseUnconfirmed: true,
            success: false,
        });
    });
});
