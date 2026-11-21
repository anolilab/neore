/**
 * Browser Rendering Worker
 *
 * Cloudflare Worker that provides browser automation via `@cloudflare/playwright`.
 * Replaces Browserbase as the browser backend for the AI agent.
 *
 * Accepts POST requests with browser actions (navigate, screenshot, click, etc.)
 * and returns results. Each request launches a fresh browser — session persistence
 * is handled by the caller (the backend's browser node) which chains requests.
 *
 * Auth: none of its own. The Worker has no public URL (`workers_dev: false`, no
 * route), so the backend's service binding (`SERVICE_BROWSER_RENDERER`) is the
 * only way in.
 */
import { Hono } from "hono";
import { z } from "zod";

import { originOf, signIn, TYPE_RESERVE_MS, withoutSecret } from "./login";

// @cloudflare/playwright types — the binding provides launch() and connect()
interface BrowserBinding {
    connect: (sessionId: string) => Promise<import("@cloudflare/playwright").Browser>;
    launch: (options?: { keepAlive?: number }) => Promise<import("@cloudflare/playwright").Browser>;
}

interface Env {
    BROWSER: BrowserBinding;
    NODE_ENV: string;
}

const app = new Hono<{ Bindings: Env }>();

// ─── Request Schema ─────────────────────────────────────────────────────────────

/** Browser keep-alive duration (ms). Sessions idle longer than this are reclaimed. */
const KEEP_ALIVE_MS = 60_000;

const actionSchema = z.object({
    action: z.enum(["navigate", "screenshot", "click", "type", "extract", "scroll"]),
    direction: z.enum(["up", "down"]).optional(),
    fullPage: z.boolean().optional(),
    selector: z.string().optional(),
    sessionId: z.string().optional(), // Reconnect to an existing browser session
    text: z.string().optional(),
    url: z.string().optional(),
});

/** Hoisted so they are compiled once, not on every request. */
const DIGITS_RE = /^\d+$/;

const HEX_GROUP_RE = /^[0-9a-f]{1,4}$/i;

// ─── URL validation ─────────────────────────────────────────────────────────────

/** Domain names that must never be navigated to (cloud metadata + localhost aliases) */
const BLOCKED_HOSTNAMES = new Set(["instance-data", "localhost", "metadata", "metadata.aws", "metadata.google.internal"]);

const ipv4ToInt = (hostname: string): number | null => {
    const parts = hostname.split(".");

    if (parts.length !== 4) return null;

    let n = 0;

    for (const p of parts) {
        if (!DIGITS_RE.test(p)) return null;

        const v = Number(p);

        if (v < 0 || v > 255) return null;

        n = (n << 8) | v;
    }

    return n >>> 0;
};

/** Returns true when the IPv4 address falls in a reserved/private/loopback/CGNAT range. */
const isPrivateIPv4 = (n: number): boolean => {
    const inRange = (cidrStart: number, prefix: number) => {
        const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;

        return (n & mask) === (cidrStart & mask);
    };

    return (
        inRange(0x00_00_00_00, 8) || // 0.0.0.0/8
        inRange(0x0a_00_00_00, 8) || // 10.0.0.0/8
        inRange(0x64_40_00_00, 10) || // 100.64.0.0/10 (CGNAT)
        inRange(0x7f_00_00_00, 8) || // 127.0.0.0/8 (full loopback)
        inRange(0xa9_fe_00_00, 16) || // 169.254.0.0/16 (link-local + AWS metadata)
        inRange(0xac_10_00_00, 12) || // 172.16.0.0/12
        inRange(0xc0_00_00_00, 24) || // 192.0.0.0/24 (IETF protocol)
        inRange(0xc0_00_02_00, 24) || // 192.0.2.0/24 (TEST-NET-1)
        inRange(0xc0_a8_00_00, 16) || // 192.168.0.0/16
        inRange(0xc6_33_64_00, 24) || // 198.51.100.0/24 (TEST-NET-2)
        inRange(0xcb_00_71_00, 24) || // 203.0.113.0/24 (TEST-NET-3)
        inRange(0xe0_00_00_00, 4) || // 224.0.0.0/4 (multicast)
        inRange(0xf0_00_00_00, 4) // 240.0.0.0/4 (reserved)
    );
};

/** Parse a stripped-bracket IPv6 hostname to canonical groups. Returns null on invalid. */
const parseIPv6 = (hostname: string): number[] | null => {
    let body = hostname;

    if (body.startsWith("[") && body.endsWith("]")) {
        body = body.slice(1, -1);
    }

    if (!body.includes(":")) return null;

    // Strip zone id
    const zoneIndex = body.indexOf("%");

    if (zoneIndex !== -1) body = body.slice(0, zoneIndex);

    const doubleIndex = body.indexOf("::");
    let parts: string[];

    if (doubleIndex === -1) {
        parts = body.split(":");
    } else {
        const left = body.slice(0, doubleIndex).split(":").filter(Boolean);
        const right = body
            .slice(doubleIndex + 2)
            .split(":")
            .filter(Boolean);
        const fill = 8 - (left.length + right.length);

        if (fill < 0) return null;

        const zeros: string[] = [];

        for (let index = 0; index < fill; index++) {
            zeros.push("0");
        }

        parts = [...left, ...zeros, ...right];
    }

    if (parts.length !== 8) return null;

    const groups: number[] = [];

    for (const p of parts) {
        if (!HEX_GROUP_RE.test(p)) return null;

        groups.push(Number.parseInt(p, 16));
    }

    return groups;
};

/** Returns true for IPv6 loopback, link-local, ULA, IPv4-mapped private, or unspecified. */
const isPrivateIPv6 = (groups: number[]): boolean => {
    // ::1 (loopback) and :: (unspecified)
    if (groups.slice(0, 7).every((g) => g === 0)) return true;

    // fe80::/10 link-local
    if ((groups[0] & 0xff_c0) === 0xfe_80) return true;

    // fc00::/7 unique-local
    if ((groups[0] & 0xfe_00) === 0xfc_00) return true;

    // ff00::/8 multicast
    if ((groups[0] & 0xff_00) === 0xff_00) return true;

    // ::ffff:a.b.c.d (IPv4-mapped) — check the embedded v4 against private ranges
    if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xff_ff) {
        const v4 = ((groups[6] << 16) | groups[7]) >>> 0;

        return isPrivateIPv4(v4);
    }

    // 64:ff9b::/96 (NAT64 — embedded v4)
    if (groups[0] === 0x00_64 && groups[1] === 0xff_9b && groups.slice(2, 6).every((g) => g === 0)) {
        const v4 = ((groups[6] << 16) | groups[7]) >>> 0;

        return isPrivateIPv4(v4);
    }

    return false;
};

const validateUrl = (url: string): string | null => {
    try {
        const parsed = new URL(url);

        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return `URL scheme "${parsed.protocol}" is not allowed. Only HTTP/HTTPS URLs are permitted`;
        }

        let hostname = parsed.hostname.toLowerCase();

        // Strip a trailing dot (FQDN form) and bracket notation for IPv6
        if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);

        const isBracketed = hostname.startsWith("[") && hostname.endsWith("]");
        const stripped = isBracketed ? hostname.slice(1, -1) : hostname;

        if (BLOCKED_HOSTNAMES.has(stripped)) {
            return `Access to ${stripped} is blocked for security reasons`;
        }

        // IPv4 literal
        const v4 = ipv4ToInt(stripped);

        if (v4 !== null) {
            if (isPrivateIPv4(v4)) {
                return `Access to private/reserved IP ${stripped} is blocked for security reasons`;
            }

            return null;
        }

        // IPv6 literal
        if (stripped.includes(":")) {
            const groups = parseIPv6(stripped);

            if (groups && isPrivateIPv6(groups)) {
                return `Access to private/reserved IPv6 ${stripped} is blocked for security reasons`;
            }
        }

        return null;
    } catch {
        return "Invalid URL";
    }
};

// ─── Browser Action Handler ─────────────────────────────────────────────────────

/** Default timeout for page operations (ms) */
/** The per-action payload merged into the response next to `sessionId`. */
interface ActionResult {
    clickedSelector?: string;
    content?: string;
    direction?: string;
    error?: string;
    screenshot?: string;
    screenshotFormat?: string;
    scrollPosition?: { maxY: number; x: number; y: number };
    success: boolean;
    title?: string;
    truncated?: boolean;
    typedSelector?: string;
    typedText?: string;
    url?: string;
}

const PAGE_TIMEOUT = 30_000;
/** Max time to wait for navigation (ms) */
const NAV_TIMEOUT = 60_000;

// `context.route()` resolves to a Disposable since @cloudflare/playwright 1.4; it is only awaited here.
const routedContexts = new WeakMap<WeakKey, Promise<unknown>>();

/** Every request any page in the context makes (clicks, redirects, subresources, popups) passes the same SSRF check. */
const guardPage = async (page: import("@cloudflare/playwright").Page) => {
    const context = page.context();
    let installed = routedContexts.get(context);

    if (!installed) {
        installed = context
            .route("**/*", async (route) => {
                if (validateUrl(route.request().url()) === null) {
                    await route.continue();
                } else {
                    await route.abort("blockedbyclient");
                }
            })
            .catch((error: unknown) => {
                routedContexts.delete(context);

                throw error;
            });
        routedContexts.set(context, installed);
    }

    await installed;
};

/**
 * Connect to an existing session or launch a new browser. keepAlive keeps the browser alive between requests so
 * multi-step workflows (navigate → click → screenshot) can reuse the same page; an expired or invalid session falls back
 * to a new launch. The session id is the caller's to persist.
 */
const openBrowser = async (
    env: Env,
    sessionId: string | undefined,
): Promise<{ browser: import("@cloudflare/playwright").Browser; isLaunched: boolean; sessionId: string }> => {
    if (sessionId) {
        try {
            return { browser: await env.BROWSER.connect(sessionId), isLaunched: false, sessionId };
        } catch {
            // Session expired or invalid — fall back to new launch
        }
    }

    const browser = await env.BROWSER.launch({ keepAlive: KEEP_ALIVE_MS });

    return { browser, isLaunched: true, sessionId: browser.sessionId() };
};

/** The session's page (a reconnected session keeps its page), guarded and with the default timeout. */
const pageOf = async (browser: import("@cloudflare/playwright").Browser): Promise<import("@cloudflare/playwright").Page> => {
    const page = browser.contexts()[0]?.pages()[0] ?? (await browser.newPage());

    page.setDefaultTimeout(PAGE_TIMEOUT);
    await guardPage(page);

    return page;
};

/**
 * The sessions this isolate's calls are using: a `/login` holds its session alone from before it connects until its
 * cleanup ends, so no `/action` (an `extract` of the filled page) runs beside it, and it waits for none.
 */
const signingIn = new Set<string>();
const acting = new Map<string, number>();

const BUSY_SIGNING_IN = "The browser session is signing in with a saved login; try again once that is done";

/** One browser action, on the session `sessionId` or a new one. */
const act = async (env: Env, { action, direction, fullPage, selector, sessionId, text, url }: z.infer<typeof actionSchema>): Promise<Response> => {
    // Validate URL for navigate action (SSRF protection)
    if (action === "navigate" && url) {
        const urlError = validateUrl(url);

        if (urlError) {
            return Response.json({ error: urlError, success: false }, { status: 400 });
        }
    }

    let browser: import("@cloudflare/playwright").Browser | undefined;
    let activeSessionId: string | undefined;

    try {
        ({ browser, sessionId: activeSessionId } = await openBrowser(env, sessionId));
    } catch (error) {
        return Response.json(
            {
                error: `Failed to launch browser: ${error instanceof Error ? error.message : String(error)}`,
                success: false,
            },
            { status: 500 },
        );
    }

    try {
        const page = await pageOf(browser);

        let result: ActionResult;

        switch (action) {
            case "click": {
                if (!selector) {
                    result = { error: "Selector is required for click action", success: false };
                    break;
                }

                await page.click(selector, { timeout: PAGE_TIMEOUT });
                await page.waitForTimeout(500);
                result = { clickedSelector: selector, success: true, url: page.url() };
                break;
            }

            case "extract": {
                let extractedText: string;

                if (selector) {
                    const element = await page.$(selector);

                    if (!element) {
                        result = { error: `Element not found: ${selector}`, success: false };
                        break;
                    }

                    extractedText = (await element.textContent()) ?? "";
                } else {
                    extractedText = await page.evaluate(() => {
                        const clone = document.body.cloneNode(true) as HTMLElement;

                        for (const element of clone.querySelectorAll("script, style, noscript, svg")) {
                            element.remove();
                        }

                        // `clone` is detached, so `innerText` would already fall back to
                        // the descendant text content — `textContent` is the same string.
                        return (clone.textContent ?? "").trim();
                    });
                }

                const maxLength = 15_000;
                const isTruncated = extractedText.length > maxLength;
                const content = isTruncated ? `${extractedText.slice(0, maxLength)}\n\n[Content truncated]` : extractedText;

                result = { content, success: true, title: await page.title(), truncated: isTruncated, url: page.url() };
                break;
            }

            case "navigate": {
                if (!url) {
                    result = { error: "URL is required for navigate action", success: false };
                    break;
                }

                await page.goto(url, { timeout: NAV_TIMEOUT, waitUntil: "domcontentloaded" });
                const title = await page.title();
                const currentUrl = page.url();

                // Validate post-redirect URL
                if (currentUrl !== url) {
                    const redirectError = validateUrl(currentUrl);

                    if (redirectError) {
                        // Scrub the page so the loaded internal content is not
                        // reachable on the next request via session reuse, and
                        // close the browser to invalidate the sessionId we
                        // would otherwise return below.
                        await page.goto("about:blank").catch(() => {});
                        await browser.close().catch(() => {});
                        activeSessionId = undefined;

                        return Response.json({ error: `Redirected to blocked URL: ${redirectError}`, success: false });
                    }
                }

                result = { success: true, title, url: currentUrl };
                break;
            }

            case "screenshot": {
                const screenshotBuffer = await page.screenshot({
                    fullPage: fullPage ?? false,
                    quality: 75,
                    type: "jpeg",
                });
                // Over 5 MB: retry at lower quality, preserving the fullPage setting.
                const finalBuffer =
                    screenshotBuffer.byteLength > 5 * 1024 * 1024
                        ? await page.screenshot({ fullPage: fullPage ?? false, quality: 60, type: "jpeg" })
                        : screenshotBuffer;

                const base64 = Buffer.from(finalBuffer).toString("base64");
                const title = await page.title();
                const currentUrl = page.url();

                result = { screenshot: base64, screenshotFormat: "jpeg", success: true, title, url: currentUrl };
                break;
            }

            case "scroll": {
                const scrollDirection = direction ?? "down";
                const amount = 500;

                if (scrollDirection === "down") {
                    await page.evaluate((px: number) => window.scrollBy(0, px), amount);
                } else {
                    await page.evaluate((px: number) => window.scrollBy(0, -px), amount);
                }

                await page.waitForTimeout(300);
                const scrollPosition = await page.evaluate(() => {
                    return {
                        maxY: document.documentElement.scrollHeight - window.innerHeight,
                        x: window.scrollX,
                        y: window.scrollY,
                    };
                });

                result = { direction: scrollDirection, scrollPosition, success: true, url: page.url() };
                break;
            }

            case "type": {
                if (!selector || !text) {
                    result = { error: "Selector and text are required for type action", success: false };
                    break;
                }

                await page.fill(selector, text, { timeout: PAGE_TIMEOUT });
                result = { success: true, typedSelector: selector, typedText: text, url: page.url() };
                break;
            }

            default: {
                result = { error: `Unknown action: ${action}`, success: false };
            }
        }

        // Include sessionId so the caller can reconnect for follow-up actions
        return Response.json({ ...result, sessionId: activeSessionId });
    } catch (error) {
        return Response.json(
            {
                error: error instanceof Error ? error.message : String(error),
                success: false,
            },
            { status: 500 },
        );
    } finally {
        // Don't close the browser — keepAlive will handle cleanup after idle timeout.
        // For reconnectable sessions we must leave the browser running.
        if (browser && !activeSessionId) {
            await browser.close().catch(() => {});
        }
    }
};

app.post("/action", async (c) => {
    // Parse request — catch malformed JSON
    let body: unknown;

    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: "Invalid JSON body", success: false }, 400);
    }

    const parsed = actionSchema.safeParse(body);

    if (!parsed.success) {
        return c.json({ error: `Invalid request: ${parsed.error.message}`, success: false }, 400);
    }

    const { action, direction, fullPage, selector, sessionId, text, url } = parsed.data;

    if (sessionId && signingIn.has(sessionId)) {
        return c.json({ error: BUSY_SIGNING_IN, success: false }, 409);
    }

    if (sessionId) {
        acting.set(sessionId, (acting.get(sessionId) ?? 0) + 1);
    }

    try {
        return await act(c.env, { action, direction, fullPage, selector, sessionId, text, url });
    } finally {
        if (sessionId) {
            const left = (acting.get(sessionId) ?? 1) - 1;

            if (left > 0) {
                acting.set(sessionId, left);
            } else {
                acting.delete(sessionId);
            }
        }
    }
});

// ─── Saved-login fill ────────────────────────────────────────────────────────────

/** The hold `/login` keeps after its deadline, for the response to get back. */
const LOGIN_MARGIN_MS = 2000;

/** The least budget a sign-in can succeed in: the margin, a page load, and the time typing and the cleanup need. */
const MIN_LOGIN_BUDGET_MS = LOGIN_MARGIN_MS + 6000 + TYPE_RESERVE_MS;

const MAX_LOGIN_BUDGET_MS = 120_000;

const loginSchema = z.object({
    /** The time the caller gives the whole call, browser setup included; nothing is typed once too little of it is left. */
    budgetMs: z.int().min(MIN_LOGIN_BUDGET_MS).max(MAX_LOGIN_BUDGET_MS).optional(),
    origin: z.string().max(2048),
    password: z.string().min(1).max(1024),
    sessionId: z.string().optional(),
    url: z.string().max(8192),
    username: z.string().min(1).max(320),
});

type Browser = import("@cloudflare/playwright").Browser;

/** `promise`, or `null` once `ms` passed. */
const settledWithin = async <T>(promise: Promise<T>, ms: number): Promise<T | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise,
            new Promise<null>((resolve) => {
                timer = setTimeout(resolve, Math.max(0, ms), null);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

/**
 * The session's browser and page for a sign-in, or `null` when they are not ready by `deadline`. A browser this call
 * launched is closed when it is late or its page cannot be set up, since nothing will use it; one reconnected to the
 * caller's session is left to its keepAlive, as `/action` leaves it: closing it would end the caller's session.
 * `sessionClosed`, also on the error it throws: the session the caller named is gone (its reconnect failed and a new
 * browser was launched instead).
 */
const setUpWithin = async (env: Env, sessionId: string | undefined, deadline: number) => {
    let isLate = false;
    let opened: { browser: Browser; isLaunched: boolean; sessionId: string } | undefined;
    const close = ({ browser, isLaunched }: { browser: Browser; isLaunched: boolean }): void => {
        if (isLaunched) {
            browser.close().catch(() => undefined);
        }
    };
    const opening = openBrowser(env, sessionId).then((result) => {
        opened = result;

        if (isLate) {
            close(result);
        }

        return result;
    });
    const isSessionClosed = (): boolean => Boolean(sessionId && opened?.isLaunched);
    const ready = await settledWithin(
        opening.then(async (result) => {
            try {
                return { ...result, page: await pageOf(result.browser) };
            } catch (error) {
                // A late one was closed as it opened.
                if (!isLate) {
                    close(result);
                }

                throw error;
            }
        }),
        deadline - Date.now(),
    ).catch((error: unknown) => {
        throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { sessionClosed: isSessionClosed() });
    });

    if (!ready) {
        isLate = true;

        if (opened) {
            close(opened);
        }
    }

    return { isSessionClosed: isSessionClosed(), opened, ready };
};

app.post("/login", async (c) => {
    let body: unknown;

    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: "Invalid JSON body", success: false }, 400);
    }

    const parsed = loginSchema.safeParse(body);

    // Never the validation message: it may quote what was sent.
    if (!parsed.success) {
        const isBudget = parsed.error.issues.some((issue) => issue.path[0] === "budgetMs");

        return c.json(
            {
                error: isBudget
                    ? `budgetMs must be from ${MIN_LOGIN_BUDGET_MS} to ${MAX_LOGIN_BUDGET_MS}: a sign-in needs at least ${MIN_LOGIN_BUDGET_MS / 1000} s`
                    : "Invalid login request",
                success: false,
            },
            400,
        );
    }

    const { budgetMs, origin, password, sessionId, url, username } = parsed.data;

    if (!origin.startsWith("https://") || originOf(url) !== origin || validateUrl(url) !== null) {
        return c.json({ error: "The login page is not on the site the login was saved for", success: false }, 400);
    }

    if (sessionId && (signingIn.has(sessionId) || acting.has(sessionId))) {
        return c.json({ error: "The browser session is busy with another call; try the sign-in again once it is done", success: false }, 409);
    }

    if (sessionId) {
        signingIn.add(sessionId);
    }

    const deadline = Date.now() + (budgetMs ?? NAV_TIMEOUT) - LOGIN_MARGIN_MS;

    try {
        const { body: answer, status } = await logIn(c.env, { deadline, origin, password, sessionId, url, username });

        return c.json(answer, status);
    } finally {
        if (sessionId) {
            signingIn.delete(sessionId);
        }
    }
});

/** The sign-in of `/login`, the browser setup included, ended by `deadline`; the browser is closed when it must be. */
const logIn = async (
    env: Env,
    {
        deadline,
        origin,
        password,
        sessionId,
        url,
        username,
    }: { deadline: number; origin: string; password: string; sessionId: string | undefined; url: string; username: string },
) => {
    const scrub = (error: unknown): string => withoutSecret(error instanceof Error ? error.message : String(error), password);
    let setup: Awaited<ReturnType<typeof setUpWithin>>;

    try {
        setup = await setUpWithin(env, sessionId, deadline);
    } catch (error) {
        const isSessionClosed = (error as { sessionClosed?: boolean }).sessionClosed === true;

        return {
            body: { error: `Failed to launch browser: ${scrub(error)}`, success: false, ...(isSessionClosed && { sessionClosed: true }) },
            status: 500,
        } as const;
    }

    const { isSessionClosed, opened, ready } = setup;

    if (!ready) {
        return {
            body: {
                error: "The browser did not start in time, so nothing was typed. Try it again.",
                success: false,
                ...(isSessionClosed && { sessionClosed: true }),
            },
            status: 504,
        } as const;
    }

    const { browser, page } = ready;
    let shouldCloseSession = !ready.sessionId;

    try {
        const result = await signIn(page, { deadline, navTimeout: NAV_TIMEOUT, origin, pageTimeout: PAGE_TIMEOUT, password, url, username });

        if (!result.success && result.sessionClosed) {
            shouldCloseSession = true;

            return { body: result, status: 200 } as const;
        }

        return { body: { ...result, sessionId: ready.sessionId }, status: 200 } as const;
    } catch (error) {
        // Before anything was typed (`signIn` handles every error after): the session holds no password.
        return { body: { error: scrub(error), sessionId: opened?.sessionId, success: false }, status: 500 } as const;
    } finally {
        if (shouldCloseSession) {
            await browser.close().catch(() => {});
        }
    }
};

// Health check
app.get("/health", (c) => c.json({ service: "browser-renderer", status: "ok" }));

export default app;
