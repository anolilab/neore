/**
 * Shared setup for the chat specs, which run against the MOCK language model.
 *
 * The LLM gateway must run with `MOCK_LLM=1` (see
 * `services/llm-gateway/src/providers/mock-model.ts`): every model then answers
 * `Mock reply: <your prompt>` deterministically, `[[reasoning]]` in a prompt adds
 * a reasoning part, and `[[tool:<name> <json>]]` makes it call that tool once.
 * The specs assert on those exact strings, so a gateway talking to a real
 * provider fails them at the first reply rather than passing by accident.
 */
import type { Locator, Page } from "@playwright/test";
import { expect, test as base } from "@playwright/test";

import { APP_BASE_URL, LUNORA_URL } from "./fixtures";
import type { AuthPoster, SeedUser } from "./seed";
import { signUpInvited } from "./seed";

/** A mock reply can take a cold backend a while; a real assertion, not a sleep. */
export const REPLY_TIMEOUT = 90_000;

/**
 * Three overlays sit on top of a fresh browser: the cookie banner, the dev-only
 * devtools "Quick start" card and, for new signed-in users, the onboarding tour.
 * None is what these specs test.
 *
 * The first two remember a dismissal in localStorage, so they are dismissed
 * once, up front, on a cheap public page ({@link settleOverlays}); the tour is
 * marked done server-side for seeded users ({@link completeOnboarding}). The
 * locator handlers stay as a fallback for anything that shows up anyway.
 */
export const dismissOverlays = async (page: Page): Promise<void> => {
    for (const name of ["Reject All", "Got it", "Skip tour"]) {
        // `noWaitAfter`: a click that lands before the overlay hydrates does
        // nothing, and the default wait for it to hide then blocked the
        // assertion that triggered the handler for its whole timeout (the
        // devtools card's "Got it", 120 retries). Without the wait, the next
        // check simply runs the handler again.
        await page.addLocatorHandler(
            page.getByRole("button", { exact: true, name }),
            async (button) => {
                await button.click();
            },
            { noWaitAfter: true },
        );
    }
};

/** Dismiss the cookie banner and the devtools card once, so their choice is stored for the whole test. */
export const settleOverlays = async (page: Page): Promise<void> => {
    await page.goto("/models");

    for (const name of ["Reject All", "Got it"]) {
        const button = page.getByRole("button", { exact: true, name });

        // Each appears after hydration, or not at all (the devtools card is dev-only).
        await button.click({ timeout: 15_000 }).catch(() => undefined);
    }
};

/**
 * Mark the onboarding tour done for the signed-in user, the way "Skip tour"
 * does, so it never opens over the page under test.
 */
export const completeOnboarding = async (page: Page): Promise<void> => {
    const tokenResponse = await page.request.get("/api/auth/token");
    const { token } = (await tokenResponse.json()) as { token?: string };

    expect(token, "a signed-in context has an RPC token").toBeTruthy();

    const response = await page.request.post(`${LUNORA_URL}/_lunora/rpc`, {
        data: { args: { onboardingCompleted: true }, functionPath: "auth_functions:updateUserSettings" },
        headers: { Authorization: `Bearer ${token ?? ""}`, Origin: new URL(APP_BASE_URL).origin },
    });

    expect(response.ok(), await response.text()).toBe(true);
};

/**
 * Click `trigger` until `opened` shows. A server-rendered button paints before
 * React attaches its handler, and a click inside that window does nothing.
 */
export const clickUntilVisible = async (trigger: Locator, opened: Locator): Promise<void> => {
    await expect(async () => {
        if (!(await opened.isVisible())) {
            await trigger.click();
        }

        await expect(opened).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
};

/** The Tiptap composer. It has no accessible name and a rotating placeholder, so it is found by class. */
export const composer = (page: Page): Locator => page.locator('.tiptap[contenteditable="true"]').first();

/** Type into the composer and send; resolves once the send button has been clicked. */
export const sendMessage = async (page: Page, text: string): Promise<void> => {
    const editor = composer(page);

    await expect(editor).toBeVisible({ timeout: 60_000 });
    await editor.click();
    await editor.fill(text);

    const send = page.getByRole("button", { exact: true, name: "Send message" });

    // Sent means the composer emptied. A click during a re-render can be lost,
    // so click again until it is — never twice once the text has gone.
    await expect(async () => {
        if (((await editor.textContent()) ?? "").trim().length > 0) {
            await send.click({ timeout: 5000 });
        }

        await expect(editor).toHaveText("", { timeout: 5000 });
    }).toPass({ timeout: 60_000 });
};

/** Settled assistant messages — not the streaming or "thinking" placeholders. */
export const assistantMessages = (page: Page): Locator =>
    page.locator('.message-item[data-message-role="assistant"]:not([data-streaming-placeholder]):not([data-thinking-placeholder])');

/** Wait until an assistant message carrying `text` is on the page, and return it. */
export const expectAssistantReply = async (page: Page, text: string | RegExp): Promise<Locator> => {
    const message = assistantMessages(page).filter({ hasText: text }).last();

    await expect(message).toBeVisible({ timeout: REPLY_TIMEOUT });

    return message;
};

/**
 * Track the page's in-flight backend HTTP requests; the returned function waits
 * until none is left (bounded).
 *
 * Closing a page while the backend still owes it a response is what kills the
 * local backend: the response is later written to a closed socket, miniflare
 * reports "Network connection lost." and wrangler 4.124 treats that as fatal
 * (CLAUDE.md → Local dev; reproduced by closing a context mid-load — 2 of 6
 * closes took the backend down). A first paint's `/_lunora/rpc-batch` can take
 * 5-10s locally, so a spec's teardown lands inside that window routinely.
 */
const drains = new WeakMap<Page, (timeoutMs?: number) => Promise<void>>();

/** Wait for `page`'s in-flight backend requests before navigating it away (see {@link trackBackendRequests}). */
export const settle = async (page: Page): Promise<void> => {
    await drains.get(page)?.();
};

export const trackBackendRequests = (page: Page): ((timeoutMs?: number) => Promise<void>) => {
    const pending = new Set<unknown>();
    const isBackend = (url: string): boolean => url.startsWith(LUNORA_URL) || url.includes("/api/auth/") || url.includes("/llm-gateway/");

    page.on("request", (request) => {
        if (isBackend(request.url())) {
            pending.add(request);
        }
    });

    page.on("requestfinished", (request) => {
        pending.delete(request);
    });
    page.on("requestfailed", (request) => {
        pending.delete(request);
    });
    // A request cut off by a navigation can end with neither event, and one
    // left in the set made every later drain wait its full timeout (a settings
    // sweep crawled at ~60s per page after one unanswered call). The old
    // document's requests cannot finish once the main frame has moved on.
    page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) {
            pending.clear();
        }
    });

    const drain = async (timeoutMs = 30_000): Promise<void> => {
        const deadline = Date.now() + timeoutMs;

        while (pending.size > 0 && Date.now() < deadline) {
            await new Promise((resolve) => {
                setTimeout(resolve, 250);
            });
        }
    };

    drains.set(page, drain);

    return drain;
};

/** Open `/chat` as whoever the page is (a guest, unless signed in first). */
export const openChat = async (page: Page): Promise<void> => {
    await settle(page);
    await page.goto("/chat");
    await expect(composer(page)).toBeVisible({ timeout: 60_000 });
};

/** A fresh invited account per test, so specs that mutate or delete it stay independent. */
export const freshUser = (label: string): SeedUser => {
    const stamp = `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;

    return { email: `e2e-${label}-${stamp}@neore.test`, name: `E2E ${label}`, password: "E2eMockPassword123!" };
};

/** Posts to the app's auth proxy from inside the page's browser context, so cookies land there. */
export const contextPoster =
    (page: Page): AuthPoster =>
    async (route, body) => {
        const response = await page.request.post(`/api/auth${route}`, { data: body, headers: { Origin: new URL(APP_BASE_URL).origin } });

        return { headers: response.headers(), status: response.status(), text: await response.text() };
    };

/**
 * Wait until the backend answers `/_lunora/status`. The local dev backend can die
 * mid-suite (wrangler's fatal "Network connection lost."); the watchdog brings
 * it back, and a spec that starts before it has would fail for that reason
 * alone.
 */
export const waitForBackend = async (timeoutMs = 120_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            // `/_lunora/status` answers before any backend setup, so it is fast
            // even under load; the long timeout matters — an abandoned probe is
            // itself a crash trigger (see `trackBackendRequests`).
            const response = await fetch(`${LUNORA_URL}/_lunora/status`, { signal: AbortSignal.timeout(30_000) });

            await response.body?.cancel();

            if (response.ok) {
                return;
            }
        } catch {
            // Down or restarting; poll again.
        }

        await new Promise((resolve) => {
            setTimeout(resolve, 2000);
        });
    }

    throw new Error(`[e2e] Backend at ${LUNORA_URL} did not answer /_lunora/status within ${String(timeoutMs / 1000)}s`);
};

/** What a page asked the backend for: one entry per query/mutation execution, plus 401s. */
export interface BackendCalls {
    /** `functionPath`s, from HTTP RPC (each call in a batch counted) and WebSocket subscribes. */
    calls: string[];
    /** Responses answered 401 — the signature of a request sent before the token landed. */
    unauthorized: string[];
}

const functionPathsIn = (payload: unknown): string[] => {
    if (Array.isArray(payload)) {
        return payload.flatMap((item) => functionPathsIn(item));
    }

    if (payload && typeof payload === "object") {
        const record = payload as Record<string, unknown>;
        const own = typeof record.functionPath === "string" ? [record.functionPath] : [];

        return [...own, ...functionPathsIn(record.calls), ...functionPathsIn(record.requests)];
    }

    return [];
};

/**
 * Record every backend function execution a page triggers, over HTTP and over
 * the live-query socket. Used to hold first paint to a budget: each execution
 * on first paint queues on the `__root__` shard, and a burst of them is what
 * makes the local backend slow enough to crash (CLAUDE.md → Local dev).
 */
export const recordBackendCalls = (page: Page): BackendCalls => {
    const record: BackendCalls = { calls: [], unauthorized: [] };

    page.on("request", (request) => {
        if (request.method() === "POST" && request.url().includes("/_lunora/rpc")) {
            try {
                const body: unknown = JSON.parse(request.postData() ?? "null");

                record.calls.push(...functionPathsIn(body));
            } catch {
                // Not JSON — nothing to count.
            }
        }
    });
    page.on("response", (response) => {
        if (response.status() === 401) {
            record.unauthorized.push(response.url());
        }
    });
    const onFrameSent = ({ payload }: { payload: Buffer | string }): void => {
        const text = typeof payload === "string" ? payload : payload.toString();

        try {
            const message = JSON.parse(text) as { type?: string };

            if (message.type === "subscribe") {
                record.calls.push(...functionPathsIn(message));
            }
        } catch {
            // Binary or non-JSON frame.
        }
    };

    page.on("websocket", (socket) => {
        socket.on("framesent", onFrameSent);
    });

    return record;
};

/**
 * `test` with a live backend and dismissed overlays on every page, and a
 * fresh invited, signed-in `user` on demand.
 */
export const test = base.extend<{ user: SeedUser; userPage: Page }>({
    page: async ({ page }, use) => {
        // Every spec starts against a live backend (the local one can be mid-restart).
        await waitForBackend();

        const drain = trackBackendRequests(page);

        // Settle BEFORE installing the handlers: a handler clicks the banner the
        // moment `settleOverlays` looks for it, so its explicit click then waits
        // out its full 15s for a button that is gone — twice, 30s of every test.
        await settleOverlays(page);
        await dismissOverlays(page);
        await use(page);
        // Close only once the backend has answered everything it was asked.
        // (Not via `about:blank` first: a navigation cancels the very requests
        // this waits for.)
        await drain();
    },
    // A new account per test that asks for one, registered through the page's
    // own context: sign-up sets the session cookie there, so there is no
    // separate sign-in (and one fewer call against better-auth's per-IP rate
    // limit). Guests never pay for it.
    user: async ({ page }, use, testInfo) => {
        const user = freshUser(testInfo.title.replaceAll(/\W+/g, "-").toLowerCase().slice(0, 24));

        await signUpInvited(user, contextPoster(page));
        await completeOnboarding(page);
        await use(user);
    },
    // The signed-in page. Names the account in the report, for reading a failure.
    userPage: async ({ page, user }, use, testInfo) => {
        testInfo.annotations.push({ description: user.email, type: "user" });
        await use(page);
    },
});

export { expect } from "@playwright/test";
