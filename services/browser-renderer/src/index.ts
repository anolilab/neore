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

const routedContexts = new WeakMap<WeakKey, Promise<void>>();

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
const openBrowser = async (env: Env, sessionId: string | undefined): Promise<{ browser: import("@cloudflare/playwright").Browser; sessionId: string }> => {
    if (sessionId) {
        try {
            return { browser: await env.BROWSER.connect(sessionId), sessionId };
        } catch {
            // Session expired or invalid — fall back to new launch
        }
    }

    const browser = await env.BROWSER.launch({ keepAlive: KEEP_ALIVE_MS });

    return { browser, sessionId: browser.sessionId() };
};

/** The session's page (a reconnected session keeps its page), guarded and with the default timeout. */
const pageOf = async (browser: import("@cloudflare/playwright").Browser): Promise<import("@cloudflare/playwright").Page> => {
    const page = browser.contexts()[0]?.pages()[0] ?? (await browser.newPage());

    page.setDefaultTimeout(PAGE_TIMEOUT);
    await guardPage(page);

    return page;
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

    // Validate URL for navigate action (SSRF protection)
    if (action === "navigate" && url) {
        const urlError = validateUrl(url);

        if (urlError) {
            return c.json({ error: urlError, success: false }, 400);
        }
    }

    let browser: import("@cloudflare/playwright").Browser | undefined;
    let activeSessionId: string | undefined;

    try {
        ({ browser, sessionId: activeSessionId } = await openBrowser(c.env, sessionId));
    } catch (error) {
        return c.json(
            {
                error: `Failed to launch browser: ${error instanceof Error ? error.message : String(error)}`,
                success: false,
            },
            500,
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

                        return c.json({ error: `Redirected to blocked URL: ${redirectError}`, success: false });
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
        return c.json({ ...result, sessionId: activeSessionId });
    } catch (error) {
        return c.json(
            {
                error: error instanceof Error ? error.message : String(error),
                success: false,
            },
            500,
        );
    } finally {
        // Don't close the browser — keepAlive will handle cleanup after idle timeout.
        // For reconnectable sessions we must leave the browser running.
        if (browser && !activeSessionId) {
            await browser.close().catch(() => {});
        }
    }
});

// ─── Saved-login fill ────────────────────────────────────────────────────────────

const loginSchema = z.object({
    /** The time the caller gives the whole call; nothing is typed once too little of it is left. */
    budgetMs: z.int().min(1000).max(120_000).optional(),
    origin: z.string().max(2048),
    password: z.string().min(1).max(1024),
    sessionId: z.string().optional(),
    url: z.string().max(8192),
    username: z.string().min(1).max(320),
});

/** The exact origin of a URL (`URL#origin`: punycode host, default port dropped), or `null` when it has none. */
const originOf = (url: string): string | null => {
    try {
        const { origin } = new URL(url);

        return origin === "null" ? null : origin;
    } catch {
        return null;
    }
};

/** Time a fill needs once it starts typing: the two fields, the submit and the wait for the next page. */
const TYPE_RESERVE_MS = 10_000;

/** `text` with the password, and the forms a URL or a form body encodes it in, replaced. */
const withoutSecret = (text: string, secret: string): string => {
    let scrubbed = text;

    for (const form of [secret, encodeURIComponent(secret), new URLSearchParams({ p: secret }).toString().slice(2)]) {
        scrubbed = scrubbed.replaceAll(form, "[password]");
    }

    return scrubbed;
};

/**
 * Sign in with a saved login, in one call so nothing a page shows in between can steer it: open `url`, check the page is
 * on `origin` (after redirects, and again right before each field is typed), type the username into the text field
 * before the first visible password field of the main frame and the password into that password field only, and send
 * the form, only by POST and only to `origin`. Nothing read back carries the password: the URL, title and any error are
 * scrubbed of it, every field still holding it is emptied as typing would, and a page that had one is reloaded, so a
 * later screenshot or extract cannot show it. Every step fits in `budgetMs`, the caller's hold.
 */
/** Whether an input holds `secret`, and whether it is a password field. */
const inputState = (element: HTMLInputElement, secret: string) => {
    return { holds: element.value === secret, isPassword: element.type === "password" };
};

/**
 * Empties every field of the page that holds `password`, as typing would (a script-driven field keeps what it was told,
 * not what its `value` was set to), and reloads a page that had one, so no state of the page brings it back. Whether a
 * password field is still there: the sign-in may have failed.
 */
const emptyPasswordFields = async (page: import("@cloudflare/playwright").Page, password: string, timeout: number): Promise<boolean> => {
    let hasPasswordField = false;
    let wasEmptied = false;
    const inputs = await page.$$("input").catch(() => []);

    for (const input of inputs) {
        const state = await input.evaluate(inputState, password).catch(() => {
            return { holds: false, isPassword: false };
        });

        hasPasswordField ||= state.isPassword;

        if (state.holds) {
            wasEmptied = true;
            await input.fill("", { timeout: 5000 }).catch(() => undefined);
        }
    }

    if (wasEmptied) {
        await page.reload({ timeout, waitUntil: "domcontentloaded" }).catch(() => undefined);
    }

    return hasPasswordField;
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
        return c.json({ error: "Invalid login request", success: false }, 400);
    }

    const { budgetMs, origin, password, sessionId, url, username } = parsed.data;

    if (!origin.startsWith("https://") || originOf(url) !== origin || validateUrl(url) !== null) {
        return c.json({ error: "The login page is not on the site the login was saved for", success: false }, 400);
    }

    const deadline = Date.now() + (budgetMs ?? NAV_TIMEOUT) - 2000;
    const left = (cap: number): number => Math.max(1, Math.min(cap, deadline - Date.now()));

    const scrub = (text: string): string => withoutSecret(text, password);

    let browser: import("@cloudflare/playwright").Browser | undefined;
    let activeSessionId: string | undefined;

    try {
        ({ browser, sessionId: activeSessionId } = await openBrowser(c.env, sessionId));
    } catch (error) {
        return c.json({ error: `Failed to launch browser: ${scrub(error instanceof Error ? error.message : String(error))}`, success: false }, 500);
    }

    try {
        const page = await pageOf(browser);
        const offSite = (): string | null => {
            const at = originOf(page.url());

            return at === origin ? null : `The page left ${origin} (it is on ${at ?? "no site"}), so nothing was typed`;
        };

        await page.goto(url, { timeout: left(NAV_TIMEOUT), waitUntil: "domcontentloaded" });

        const landed = offSite();

        if (landed) {
            return c.json({ error: landed, sessionId: activeSessionId, success: false, url: scrub(page.url()) });
        }

        // The main frame only: a frame of another site is never typed into.
        const field = await page
            .locator('input[type="password"]:visible')
            .first()
            .elementHandle({ timeout: left(PAGE_TIMEOUT) })
            .catch(() => null);

        if (!field) {
            return c.json({ error: "No password field is on the page", sessionId: activeSessionId, success: false, url: scrub(page.url()) });
        }

        // Where Enter sends the form: its default button's `formaction`/`formmethod`, else the form's own. No method is GET,
        // which would put the password in the address: such a form is sent by POST; one that names another method is refused.
        const sends = await field.evaluate((input) => {
            const { form } = input as HTMLInputElement;

            if (!form) {
                return { action: document.location.href, method: "post" };
            }

            const button = form.querySelector('button:not([type]), button[type="submit" i], input[type="submit" i]');
            const named = button?.getAttribute("formmethod") ?? form.getAttribute("method");
            const action = new URL(button?.getAttribute("formaction") ?? form.getAttribute("action") ?? "", document.baseURI).href;

            if (named === null) {
                form.setAttribute("method", "post");
            }

            return { action, method: (named ?? "post").toLowerCase() };
        });

        if (sends.method !== "post" || originOf(sends.action) !== origin) {
            return c.json({
                error: `The login form would not send the password to ${origin} by POST, so nothing was typed`,
                sessionId: activeSessionId,
                success: false,
            });
        }

        if (deadline - Date.now() < TYPE_RESERVE_MS) {
            return c.json({ error: "Too little time was left to sign in, so nothing was typed. Try it again.", sessionId: activeSessionId, success: false });
        }

        const userCandidate = await field.evaluateHandle((input) => {
            const scope = (input as HTMLInputElement).form ?? document;
            const before = [...scope.querySelectorAll("input")].filter(
                (candidate) =>
                    ["", "email", "tel", "text"].includes(candidate.getAttribute("type")?.toLowerCase() ?? "") &&
                    candidate.getClientRects().length > 0 &&
                    Boolean(candidate.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING),
            );

            return before.at(-1) ?? null;
        });
        const user = userCandidate.asElement();

        let moved = offSite();

        if (!moved && user) {
            await user.fill(username, { timeout: left(PAGE_TIMEOUT) });
            moved = offSite();
        }

        if (moved || !(await field.evaluate((input) => input.isConnected && (input as HTMLInputElement).type === "password"))) {
            return c.json({
                error: moved ?? "The password field changed before it was typed into, so it was left empty",
                sessionId: activeSessionId,
                success: false,
            });
        }

        await field.fill(password, { timeout: left(PAGE_TIMEOUT) });
        // A page with an unload listener is never kept in the back/forward cache, where the filled form would wait.
        await page.evaluate(() => window.addEventListener("unload", () => undefined)).catch(() => undefined);
        await field.press("Enter", { timeout: left(PAGE_TIMEOUT) });
        await page.waitForTimeout(left(1500));
        await page.waitForLoadState("domcontentloaded", { timeout: left(NAV_TIMEOUT) }).catch(() => undefined);

        const passwordFieldRemains = await emptyPasswordFields(page, password, left(NAV_TIMEOUT));

        return c.json({
            passwordFieldRemains,
            sessionId: activeSessionId,
            submitted: true,
            success: true,
            title: scrub(await page.title()),
            url: scrub(page.url()),
        });
    } catch (error) {
        return c.json({ error: scrub(error instanceof Error ? error.message : String(error)), sessionId: activeSessionId, success: false }, 500);
    } finally {
        if (browser && !activeSessionId) {
            await browser.close().catch(() => {});
        }
    }
});

// Health check
app.get("/health", (c) => c.json({ service: "browser-renderer", status: "ok" }));

export default app;
