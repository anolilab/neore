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
import type { BrowserWorker } from "@cloudflare/playwright";
import { connect, launch, sessions } from "@cloudflare/playwright";
import { Hono } from "hono";
import { z } from "zod";

import type { SecretScan } from "./login";
import { originOf, ownMessage, secretScan, signIn, TYPE_RESERVE_MS } from "./login";
import type { HoldKind, SessionHold } from "./session-lock";
import { holdSession, LEASE_MS } from "./session-lock";
import { readTarget, TARGET_READ_OPTIONS } from "./target-read";

// The Durable Object the `SESSION_LOCK` binding names: exported by the Worker's main module.
export { SessionLock } from "./session-lock";

interface Env {
    /** The Browser Run binding: opened through `@cloudflare/playwright`'s `launch` and `connect`, never called directly. */
    BROWSER: BrowserWorker;
    NODE_ENV: string;
    /** The hold on each browser session every isolate sees (`src/session-lock.ts`). */
    SESSION_LOCK: DurableObjectNamespace;
}

const app = new Hono<{ Bindings: Env }>();

// ─── Request Schema ─────────────────────────────────────────────────────────────

/** Browser keep-alive duration (ms). Sessions idle longer than this are reclaimed. */
const KEEP_ALIVE_MS = 60_000;

const actionSchema = z.object({
    action: z.enum(["navigate", "screenshot", "click", "type", "extract", "scroll"]),
    clickMode: z.enum(["page", "pointer", "all"]).optional(), // click, with `expectTarget`: "page" checks and clicks in the page; "all" checks, then a real click
    direction: z.enum(["up", "down"]).optional(),
    expectTarget: z.string().optional(), // click: the `target` of the element the person was shown; refused when it differs
    fullPage: z.boolean().optional(),
    // screenshot: one over this many bytes is taken again at a lower quality, so it fits the caller's answer.
    maxBytes: z.int().positive().optional(),
    // A person's view of the page: a session that cannot be reconnected is gone (404, nothing run), never replaced by a new browser.
    reconnectOnly: z.boolean().optional(),
    selector: z.string().optional(),
    sessionId: z.string().optional(), // Reconnect to an existing browser session
    strictVisibility: z.boolean().optional(), // click: refuse an element opacity hides too (an approved click); an ordinary click ignores opacity
    text: z.string().optional(),
    url: z.string().optional(),
    visibleOnly: z.boolean().optional(), // extract with a selector: the rendered text a person sees, not the raw textContent
});

/** Hoisted so they are compiled once, not on every request. */
const DIGITS_RE = /^\d+$/;

/** A disabled control is not clicked on an approved target: it is not clicked until it is enabled, on a fresh look. */
const DISABLED_TARGET = "The target is disabled, so nothing was clicked. Look at the page again before you click.";

/** The target changed while the press ran its handlers: nothing was clicked, and the press is not retried (its handlers ran). */
const PRESS_CHANGED = "The target changed while the press ran its handlers, so nothing was clicked. Its handlers did run; look at the page before you act.";

/** Another element (a dialog, an overlay) covers the target, so the press would land on it: nothing is clicked. */
const COVERED_TARGET = "Another element covers the target (a dialog or an overlay), so nothing was clicked. Look at the page again before you click.";

/** The target is not drawn (hidden), so an approved click is not dispatched to it. */
const NOT_VISIBLE_TARGET = "The target is not visible, so nothing was clicked. Look at the page again before you click.";

/** A click ran, and a page handler moved its destination during it: the browser stopped the submission. Its handlers did run. */
const DESTINATION_MOVED =
    "The page moved this click's destination while the click ran, so the browser stopped the submission. Its handlers did run; look at the page before you act.";

/** The click found another element, or this one with other text: the person's yes was for what they were shown. */
const TARGET_CHANGED = "The target changed since it was checked, so nothing was clicked. Look at the page again before you click.";

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
    /** The element is on a checkout: a form with card or bank fields, or a page whose address says so (`visibleOnly` reads only). */
    checkout?: boolean;
    clickedSelector?: string;
    content?: string;
    direction?: string;
    error?: string;
    /** The control's accessible name when it is not its text (`visibleOnly` reads only): aria-label, labelled-by text, title, a submit button's value. */
    label?: string;
    labelTruncated?: boolean;
    screenshot?: string;
    screenshotFormat?: string;
    scrollPosition?: { maxY: number; x: number; y: number };
    /** One of the control's name sources is exactly a submit word (`visibleOnly` reads only). */
    submitLike?: boolean;
    /** One of the control's name sources is exactly a bare subscription word (`visibleOnly` reads only). */
    subscribeLike?: boolean;
    success: boolean;
    /** The fingerprint of the extracted element (`visibleOnly` reads only), which a click can be checked against. */
    target?: string;
    /** A click was refused because its target changed since it was checked (`expectTarget`); nothing was clicked. */
    targetChanged?: boolean;
    title?: string;
    truncated?: boolean;
    typedSelector?: string;
    typedText?: string;
    url?: string;
    /** A screenshot's viewport, in CSS pixels: the size the image shows, when it is not of the full page. */
    viewport?: { height: number; width: number };
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
    onSessionGone?: () => void,
): Promise<{ browser: import("@cloudflare/playwright").Browser; isLaunched: boolean; sessionId: string }> => {
    if (sessionId) {
        try {
            return { browser: await connect(env.BROWSER, sessionId), isLaunched: false, sessionId };
        } catch {
            // Session expired or invalid — fall back to new launch. Said at once: the launch may never finish.
            onSessionGone?.();
        }
    }

    const browser = await launch(env.BROWSER, { keep_alive: KEEP_ALIVE_MS });

    return { browser, isLaunched: true, sessionId: browser.sessionId() };
};

/** The `code` of a reconnect-only action's answer when its session could not be reconnected: nothing was launched or run. */
const SESSION_GONE = "SESSION_GONE";

class SessionGoneError extends Error {}

/**
 * Reconnects to `sessionId` and nothing else: a person's view of the page must never start a browser the agent would
 * then pay for, nor stand in for one the provider reaped.
 */
const reconnectOnlyTo = async (
    env: Env,
    sessionId: string,
): Promise<{ browser: import("@cloudflare/playwright").Browser; isLaunched: false; sessionId: string }> => {
    try {
        return { browser: await connect(env.BROWSER, sessionId), isLaunched: false, sessionId };
    } catch (error) {
        // Gone only when the provider no longer lists it: a connect that failed for another reason is a failure (500),
        // not a closed browser.
        const active = await sessions(env.BROWSER).catch(() => undefined);

        if (active?.every((session) => session.sessionId !== sessionId) === true) {
            throw new SessionGoneError();
        }

        throw error;
    }
};

/** `size` as a viewport, or `null` unless both sides are finite positive numbers. */
const viewportOf = (size: { height: unknown; width: unknown } | null): { height: number; width: number } | null => {
    const isSide = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

    return size !== null && isSide(size.height) && isSide(size.width) ? { height: size.height, width: size.width } : null;
};

/** The session's page as {@link pageOf} sets it up, or `undefined` when it has none: none is opened. */
const existingPageOf = async (browser: import("@cloudflare/playwright").Browser): Promise<import("@cloudflare/playwright").Page | undefined> => {
    const page = browser.contexts()[0]?.pages()[0];

    return page === undefined ? undefined : await pageOf(browser);
};

/** The session's page (a reconnected session keeps its page), guarded and with the default timeout. */
const pageOf = async (browser: import("@cloudflare/playwright").Browser): Promise<import("@cloudflare/playwright").Page> => {
    const page = browser.contexts()[0]?.pages()[0] ?? (await browser.newPage());

    page.setDefaultTimeout(PAGE_TIMEOUT);
    await guardPage(page);

    return page;
};

const BUSY_SIGNING_IN = "The browser session is signing in with a saved login; try again once that is done";

const BUSY_IN_USE = "The browser session is busy with another call; try the sign-in again once it is done";

/** How long a sign-in waits for a session another call holds before it is refused, and how often it asks again. */
const LOGIN_BUSY_WAIT_MS = 3000;
const LOGIN_BUSY_STEP_MS = 250;

const LOCK_UNREACHABLE = "The browser session's lock did not answer in time, so nothing was run; try it again in a moment";

/**
 * The header on an `/action` answer that ran nothing (a session held by a sign-in, retired, or whose lock did not
 * answer): the backend gives back the rate-limit charge such an action took.
 */
const NOT_RUN = { "x-browser-action": "not-run" } as const;

/** A session refused for good (`SessionHolds.isRetired`): the caller starts a new one, with no `sessionId`. */
const SESSION_RETIRED = "SESSION_RETIRED";

const retiredAnswer = (what: string) =>
    Response.json(
        { code: SESSION_RETIRED, error: `The browser session was retired and is never used again, so ${what}; start a new session`, success: false },
        { headers: NOT_RUN, status: 410 },
    );

/**
 * The holds one call keeps on the sessions it uses (`src/session-lock.ts`), shared by every isolate: a `/login` holds
 * its session alone from before it connects until its cleanup ends, so no `/action` of any isolate (an `extract` of the
 * page the site answered the sign-in with) runs beside it, and it waits for none; an `/action` holds it beside other
 * actions. A session an `/action` launched is held too, before its page is set up; one a `/login` launched once its
 * browser and page are set up (its id has not left the call yet), before the holds are armed (`arm`) and the sign-in
 * starts. `take` answers why one was not taken.
 */
const holdsOf = (env: Env, kind: HoldKind, keep?: (work: Promise<unknown>) => void) => {
    const held: SessionHold[] = [];

    return {
        /** Arms every hold (`SessionHold.arm`): whether the lock answered each. */
        arm: async (): Promise<boolean> => {
            const armed = await Promise.all(held.map(async (hold) => hold.arm()));

            return armed.every(Boolean);
        },
        held,
        /** Ends every hold, within `ms`: whether each was in force all along. */
        release: async (ms?: number): Promise<boolean> => {
            const released = await Promise.all(held.map(async (hold) => hold.release(ms)));

            return released.every(Boolean);
        },
        /** Sends each release the lock has not answered again, while its lease runs (`SessionHold.settle`). */
        settle: async (): Promise<void> => {
            await Promise.all(held.map(async (hold) => hold.settle()));
        },
        /** `ms`: how long the take may wait for the lock (`holdSession`'s `takeMs`). */
        take: async (sessionId: string, ms?: number): Promise<"busy" | "retired" | "unreachable" | null> => {
            const taken = await holdSession(env.SESSION_LOCK, sessionId, kind, { keep, ...(ms !== undefined && { takeMs: ms }) });

            if (taken === "unreachable" || taken === "retired") {
                return taken;
            }

            if ("busy" in taken) {
                return "busy";
            }

            held.push(taken);

            return null;
        },
    };
};

/**
 * One browser action, on the session `sessionId` or a new one, held beside other actions for its whole run. Its answer
 * goes out only when every hold was in force all along: one that may have lapsed could have let a sign-in onto the
 * session meanwhile, whose page the answer may show. A hold that may lapse closes the action's browser at once, well
 * before the lease ends, so the action drives the page no further; a release the lock is merely slow to answer, after
 * an action whose hold held throughout, keeps the result.
 */
const act = async (env: Env, body: z.infer<typeof actionSchema>, keep?: (work: Promise<unknown>) => void): Promise<Response> => {
    const holds = holdsOf(env, "shared", keep);

    // Taken before it connects: a session signing in is never reached.
    const refused = body.sessionId ? await holds.take(body.sessionId) : null;

    if (refused === "retired") {
        return retiredAnswer("nothing was run");
    }

    if (refused) {
        return refused === "busy"
            ? Response.json({ error: BUSY_SIGNING_IN, success: false }, { headers: NOT_RUN, status: 409 })
            : Response.json({ error: LOCK_UNREACHABLE, success: false }, { headers: NOT_RUN, status: 503 });
    }

    let response: Response | undefined;

    try {
        response = await actHeld(env, body, holds);
    } finally {
        const isHeld = await holds.release();

        if (!isHeld && response) {
            // The action may have run: the caller is told to look before it repeats it, and keeps the browser it has
            // (a browser the lost hold closed has no id in the answer any more).
            const { sessionId: kept } = (await response
                .clone()
                .json()
                .catch(() => {
                    return {};
                })) as { sessionId?: unknown };

            response = Response.json(
                {
                    error: "The browser session's hold could not be confirmed for the whole action, so its result is withheld. The action may have run: look at the page before you repeat it",
                    ...(typeof kept === "string" && { sessionId: kept }),
                    success: false,
                },
                // An answer that ran nothing still says so: its rate-limit charge is given back.
                { status: 503, ...(response.headers.get("x-browser-action") === "not-run" && { headers: NOT_RUN }) },
            );
        }
    }

    return response;
};

const actHeld = async (
    env: Env,
    {
        action,
        clickMode,
        direction,
        expectTarget,
        fullPage,
        maxBytes,
        reconnectOnly,
        selector,
        sessionId,
        strictVisibility,
        text,
        url,
        visibleOnly,
    }: z.infer<typeof actionSchema>,
    holds: ReturnType<typeof holdsOf>,
): Promise<Response> => {
    if (reconnectOnly === true && !sessionId) {
        return Response.json({ error: "A reconnect-only action needs the session it reconnects to", success: false }, { headers: NOT_RUN, status: 400 });
    }

    // Validate URL for navigate action (SSRF protection)
    if (action === "navigate" && url) {
        const urlError = validateUrl(url);

        if (urlError) {
            return Response.json({ error: urlError, success: false }, { status: 400 });
        }
    }

    let browser: import("@cloudflare/playwright").Browser | undefined;
    let activeSessionId: string | undefined;
    let isLaunched: boolean;

    try {
        ({
            browser,
            isLaunched,
            sessionId: activeSessionId,
        } = reconnectOnly === true && sessionId ? await reconnectOnlyTo(env, sessionId) : await openBrowser(env, sessionId));
    } catch (error) {
        if (error instanceof SessionGoneError) {
            return Response.json(
                { code: SESSION_GONE, error: "The browser session is gone; nothing was run", success: false },
                { headers: NOT_RUN, status: 404 },
            );
        }

        return Response.json(
            {
                error: `Failed to launch browser: ${error instanceof Error ? error.message : String(error)}`,
                success: false,
            },
            { status: 500 },
        );
    }

    // A hold that may lapse stops the action where it is: its browser connection is closed, and every page call with it.
    const opened = browser;
    const stopOnLost = (): void => {
        activeSessionId = undefined;
        opened.close().catch(() => undefined);
    };

    for (const hold of holds.held) {
        hold.onLost(stopOnLost);
    }

    try {
        // A session launched here is held as well, before its page is set up: its id is out once this answers.
        const refused = isLaunched ? await holds.take(activeSessionId) : null;

        if (isLaunched && !refused) {
            holds.held.at(-1)?.onLost(stopOnLost);
        }

        if (refused === "retired") {
            await browser.close().catch(() => {});
            activeSessionId = undefined;

            return retiredAnswer("nothing was run");
        }

        if (refused) {
            await browser.close().catch(() => {});
            activeSessionId = undefined;

            return Response.json(
                { error: refused === "busy" ? BUSY_SIGNING_IN : LOCK_UNREACHABLE, success: false },
                { headers: NOT_RUN, status: refused === "busy" ? 409 : 503 },
            );
        }

        // A person's view of the page never opens one: a browser with no page has nothing to show.
        const page = reconnectOnly === true ? await existingPageOf(browser) : await pageOf(browser);

        if (page === undefined) {
            return Response.json({ error: "The browser has no page open; nothing was run", success: false }, { headers: NOT_RUN, status: 422 });
        }

        let result: ActionResult;

        switch (action) {
            case "click": {
                if (!selector) {
                    result = { error: "Selector is required for click action", success: false };
                    break;
                }

                if (expectTarget === undefined) {
                    await page.click(selector, { timeout: PAGE_TIMEOUT });
                } else if (clickMode === "all" && strictVisibility !== true) {
                    // (An approved click takes the in-page path below: its form is submitted by the renderer to the approved destination.)
                    // A real click after the check. A page handler can run between the two (the trade-off this mode is chosen for), so
                    // the check is not one step with the click here. A changed or disabled target is still refused before the click.
                    const element = await page.$(selector);

                    if (!element) {
                        result = { error: `Element not found: ${selector}`, success: false };
                        break;
                    }

                    const read = await element.evaluate(readTarget, { ...TARGET_READ_OPTIONS, expect: expectTarget });

                    if (read.refused === "changed") {
                        result = { error: TARGET_CHANGED, success: false, targetChanged: true };
                        break;
                    }

                    if (await element.isDisabled()) {
                        result = { error: DISABLED_TARGET, success: false };
                        break;
                    }

                    await element.click({ timeout: PAGE_TIMEOUT });
                } else {
                    // The check and the click run as one step in the page (`readTarget` with `click`): the fingerprint is compared
                    // and the element clicked with nothing in between, so a page change after the check cannot reach the click.
                    const element = await page.$(selector);

                    if (!element) {
                        result = { error: `Element not found: ${selector}`, success: false };
                        break;
                    }

                    const read = await element.evaluate(readTarget, {
                        click: true,
                        expect: expectTarget,
                        strict: strictVisibility === true,
                        ...TARGET_READ_OPTIONS,
                    });

                    if (read.refused === "changed") {
                        result = { error: TARGET_CHANGED, success: false, targetChanged: true };
                        break;
                    }

                    if (read.refused === "disabled") {
                        result = { error: DISABLED_TARGET, success: false };
                        break;
                    }

                    // The click ran, and a page handler moved its destination: the browser stopped the submission. Not a changed target
                    // (no `targetChanged`): the click must not be retried, since its handlers already ran.
                    if (read.refused === "moved") {
                        result = { error: DESTINATION_MOVED, success: false };
                        break;
                    }

                    if (read.refused === "pressed") {
                        result = { error: PRESS_CHANGED, success: false };
                        break;
                    }

                    if (read.refused === "covered") {
                        result = { error: COVERED_TARGET, success: false };
                        break;
                    }

                    if (read.refused === "hidden") {
                        result = { error: NOT_VISIBLE_TARGET, success: false };
                        break;
                    }
                }

                await page.waitForTimeout(500);
                result = { clickedSelector: selector, success: true, url: page.url() };
                break;
            }

            case "extract": {
                let extractedText: string;
                let label: string | undefined;
                let isLabelTruncated = false;
                let target: string | undefined;
                let isCheckout = false;
                let isSubmitLike = false;
                let isSubscribeLike = false;

                if (selector) {
                    const element = await page.$(selector);

                    if (!element) {
                        result = { error: `Element not found: ${selector}`, success: false };
                        break;
                    }

                    if (visibleOnly === true) {
                        // The rendered text and the fingerprint come from one read of the element, so they describe the same state of
                        // the page: two reads could pair a purchase's text with an ordinary fingerprint when the page changes between them.
                        // The text is `innerText` (hidden descendants left out, so a purchase word the person cannot see does not count),
                        // or the element's own text for an SVG, which has no innerText. The rendered text is read on purpose.
                        const read = await element.evaluate(readTarget, {
                            ...TARGET_READ_OPTIONS,
                        });

                        extractedText = read.shown;
                        label = read.label;
                        isLabelTruncated = read.labelTruncated;
                        target = read.target;
                        isCheckout = read.checkout;
                        isSubmitLike = read.submitLike;
                        isSubscribeLike = read.subscribeLike;
                    } else {
                        // An ordinary extract keeps the raw text it always returned.
                        extractedText = (await element.textContent()) ?? "";
                    }
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

                result = {
                    content,
                    success: true,
                    title: await page.title(),
                    truncated: isTruncated,
                    url: page.url(),
                    ...(label !== undefined && { label }),
                    ...(isLabelTruncated && { labelTruncated: true }),
                    ...(target !== undefined && { target }),
                    ...(isCheckout && { checkout: true }),
                    ...(isSubscribeLike && { subscribeLike: true }),
                    ...(isSubmitLike && { submitLike: true }),
                };
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
                const fitted =
                    maxBytes !== undefined && finalBuffer.byteLength > maxBytes
                        ? await page.screenshot({ fullPage: fullPage ?? false, quality: 40, type: "jpeg" })
                        : finalBuffer;

                const base64 = Buffer.from(fitted).toString("base64");
                const title = await page.title();
                const currentUrl = page.url();

                // Playwright's own size first; a reconnected session may carry none, so then the page's, which page script can
                // overwrite: kept only as two finite positive numbers.
                // Only a person's view of the page (`reconnectOnly`) carries the size: the agent's answer stays as it was.
                const viewport =
                    reconnectOnly === true
                        ? viewportOf(
                              page.viewportSize() ??
                                  (await page
                                      .evaluate(() => {
                                          return { height: window.innerHeight as unknown, width: window.innerWidth as unknown };
                                      })
                                      .catch(() => null)),
                          )
                        : null;

                result = { screenshot: base64, screenshotFormat: "jpeg", success: true, title, url: currentUrl, ...(viewport !== null && { viewport }) };
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

    return act(c.env, parsed.data, (work) => {
        afterAnswer(c, work);
    });
});

// ─── Saved-login fill ────────────────────────────────────────────────────────────

/** The hold `/login` keeps after its deadline, for the response to get back. */
const LOGIN_MARGIN_MS = 2000;

/**
 * The least wait for a close the sign-in asks for, taken from the margin when the sign-in ends at its deadline: a close
 * that ends that quickly is confirmed (`sessionClosed`) rather than answered as unconfirmed.
 */
const MIN_CLOSE_WAIT_MS = 500;

/** The end of the margin kept for the release and the answer once a close is confirmed: no close wait runs into it. */
const RELEASE_MS = 500;

/** The least budget a sign-in can succeed in: the margin, a page load, and the time typing and the cleanup need. */
const MIN_LOGIN_BUDGET_MS = LOGIN_MARGIN_MS + 6000 + TYPE_RESERVE_MS;

const MAX_LOGIN_BUDGET_MS = 120_000;

/**
 * The shortest password `/login` fills. A shorter one cannot be scrubbed from what the browser returns: its base64 is two
 * or three characters, found in almost any text, so withholding every match would withhold nearly every result.
 */
const MIN_LOGIN_PASSWORD_LENGTH = 4;

const loginSchema = z.object({
    /** The time the caller gives the whole call, browser setup included; nothing is typed once too little of it is left. */
    budgetMs: z.int().min(MIN_LOGIN_BUDGET_MS).max(MAX_LOGIN_BUDGET_MS).optional(),
    origin: z.string().max(2048),
    password: z.string().min(MIN_LOGIN_PASSWORD_LENGTH).max(1024),
    sessionId: z.string().optional(),
    url: z.string().max(8192),
    username: z.string().min(1).max(320),
});

type Browser = import("@cloudflare/playwright").Browser;

/**
 * Ends the browser session itself: whether it confirmably did. `close()` ends a browser this call launched, but only
 * disconnects from one it reconnected to (Playwright's `close()` on a connected browser), whose session would go on
 * with the page: that one is sent the browser's own `Browser.close`, and counts as ended once the browser takes it.
 */
const endSession = async (browser: Browser, isLaunched: boolean): Promise<boolean> => {
    if (isLaunched) {
        try {
            await browser.close();

            return true;
        } catch {
            return false;
        }
    }

    let isEnded = false;

    try {
        const cdp = await browser.newBrowserCDPSession();

        await cdp.send("Browser.close");
        isEnded = true;
    } catch {
        // Not taken: the session may go on.
    }

    await browser.close().catch(() => undefined);

    return isEnded;
};

/** A sentence's closing full stop, dropped before more is said after it. */
const TRAILING_STOP_RE = /\.$/u;

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
    // The caller's session could not be reconnected: it is gone, whether or not a new browser opens in time.
    let isSessionGone = false;
    const close = ({ browser, isLaunched }: { browser: Browser; isLaunched: boolean }): void => {
        if (isLaunched) {
            browser.close().catch(() => undefined);
        }
    };
    const opening = openBrowser(env, sessionId, () => {
        isSessionGone = true;
    }).then((result) => {
        opened = result;

        if (isLate) {
            close(result);
        }

        return result;
    });
    const isSessionClosed = (): boolean => Boolean(sessionId && (isSessionGone || opened?.isLaunched));
    const setting = opening.then(async (result) => {
        try {
            return { ...result, page: await pageOf(result.browser) };
        } catch (error) {
            // A late one was closed as it opened.
            if (!isLate) {
                close(result);
            }

            throw error;
        }
    });
    const ready = await settledWithin(setting, deadline - Date.now()).catch((error: unknown) => {
        throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { sessionClosed: isSessionClosed() });
    });

    // Settles once nothing of the setup runs any more (a late one's browser closed when it launched it): until then a
    // late setup still drives the session, so its hold is kept.
    let settling: Promise<boolean> | undefined;

    if (!ready) {
        isLate = true;

        if (opened) {
            close(opened);
        }

        settling = setting.then(() => true).catch(() => true);
    }

    return { isSessionClosed: isSessionClosed(), opened, ready, settling };
};

/** Keeps `work` running past the answer. */
const afterAnswer = (c: { executionCtx: { waitUntil: (promise: Promise<unknown>) => void } }, work: Promise<unknown>): void => {
    try {
        c.executionCtx.waitUntil(work);
    } catch {
        // No execution context (a test's request): the work goes on regardless.
    }
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
        const isShortPassword = parsed.error.issues.some((issue) => issue.path[0] === "password" && issue.code === "too_small");
        let error = "Invalid login request";

        if (isBudget) {
            error = `budgetMs must be from ${MIN_LOGIN_BUDGET_MS} to ${MAX_LOGIN_BUDGET_MS}: a sign-in needs at least ${MIN_LOGIN_BUDGET_MS / 1000} s`;
        } else if (isShortPassword) {
            error = `A saved password shorter than ${MIN_LOGIN_PASSWORD_LENGTH} characters is not filled: it could not be kept out of what the browser returns`;
        }

        return c.json(
            {
                error,
                success: false,
            },
            400,
        );
    }

    const { budgetMs, origin, password, sessionId, url, username } = parsed.data;

    if (!origin.startsWith("https://") || originOf(url) !== origin || validateUrl(url) !== null) {
        return c.json({ error: "The login page is not on the site the login was saved for", success: false }, 400);
    }

    const deadline = Date.now() + (budgetMs ?? NAV_TIMEOUT) - LOGIN_MARGIN_MS;
    const holds = holdsOf(c.env, "exclusive", (work) => {
        afterAnswer(c, work);
    });
    // Taken before it connects, and refused while any other call holds the session: nothing is typed unheld.
    let refused = sessionId ? await holds.take(sessionId) : null;

    // Another call holds the session: wait a moment for it (a person's frame of the page lets go within a second or
    // two), within the sign-in's budget, then refuse as before.
    for (const until = Math.min(Date.now() + LOGIN_BUSY_WAIT_MS, deadline); refused === "busy" && sessionId && Date.now() + LOGIN_BUSY_STEP_MS < until;) {
        await new Promise((resolve) => {
            setTimeout(resolve, LOGIN_BUSY_STEP_MS);
        });
        // Bounded by what is left of the wait, so a lock slow to answer never runs the sign-in past its deadline. Too
        // little left to ask, or a lock that did not answer in it: the session was busy, and that is what is said.
        const left = until - Date.now();

        if (left < LOGIN_BUSY_STEP_MS) {
            break;
        }

        const retried = await holds.take(sessionId, left);

        refused = retried === "unreachable" ? "busy" : retried;
    }

    if (refused === "retired") {
        return retiredAnswer("nothing was typed");
    }

    if (refused) {
        return refused === "busy"
            ? c.json({ error: BUSY_IN_USE, success: false }, 409)
            : c.json({ error: "The browser session's lock did not answer in time, so nothing was typed; try it again in a moment", success: false }, 503);
    }

    let closing: Promise<boolean> | undefined;

    try {
        const { body: answer, status } = await logIn(c.env, {
            deadline,
            // Closed once either close confirmed it.
            hold: (pending) => {
                const before = closing;

                closing = before ? Promise.all([before, pending]).then((closed) => closed.some(Boolean)) : pending;
            },
            holds,
            origin,
            password,
            sessionId,
            url,
            username,
        });

        return c.json(answer, status);
    } finally {
        const held = closing;

        if (held) {
            // A close still under way: the session stays held past the answer, until the close ends, and at most for
            // as long as a browser left open idles before Browser Rendering reclaims it. One that fails keeps it held so.
            const lingering = Promise.all(holds.held.map(async (hold) => hold.linger(KEEP_ALIVE_MS + LEASE_MS)));
            // After the linger: a release that overtook it would be undone by it.
            const releasing = Promise.all([held, lingering]).then(async ([hasClosed]) => (hasClosed ? holds.release().then(holds.settle) : undefined));

            afterAnswer(c, releasing);
        } else {
            // The rest of the margin is the answer's. A release whose answer is lost there is sent again past the
            // answer, while the lease runs: left to lapse, the hold would retire a session the cleanup left clean.
            await holds.release(Math.max(RELEASE_MS, deadline + LOGIN_MARGIN_MS - Date.now()));
            afterAnswer(c, holds.settle());
        }
    }
});

/**
 * The sign-in of `/login`, the browser setup included, ended by `deadline`; the browser is closed when it must be. A close
 * that has not ended by `deadline` (or `MIN_CLOSE_WAIT_MS` after it was asked for, inside the margin, when the sign-in
 * ended late; the rest of the margin is the answer's), or that failed, is handed to `hold` (`false` when it fails) and the answer
 * goes out without waiting for it, saying `sessionCloseUnconfirmed` instead of `sessionClosed`.
 */
const logIn = async (
    env: Env,
    {
        deadline,
        hold,
        holds,
        origin,
        password,
        sessionId,
        url,
        username,
    }: {
        deadline: number;
        hold: (closing: Promise<boolean>) => void;
        holds: ReturnType<typeof holdsOf>;
        origin: string;
        password: string;
        sessionId: string | undefined;
        url: string;
        username: string;
    },
) => {
    // One budget for every text the call checks for the password, the sign-in's own included.
    const scan = secretScan(password);
    const scrub = (error: unknown): string => scan.without(error instanceof Error ? error.message : String(error));
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

    const { isSessionClosed, opened, ready, settling } = setup;

    if (!ready) {
        // A setup still under way keeps the session held until it ends, as a close does; one that never ends lets the
        // hold lapse, which retires the session.
        if (settling) {
            hold(settling);
        }

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
    // A session launched here is held as well, before anything is typed: its id is out once this answers.
    // Within the sign-in's deadline: a setup that ended late leaves the take no time past it.
    const refused = ready.isLaunched ? await holds.take(ready.sessionId, deadline - Date.now()) : null;

    if (refused) {
        await settledWithin(
            browser.close().catch(() => undefined),
            deadline - Date.now(),
        );

        return {
            body: {
                error:
                    refused === "busy"
                        ? "The browser session is busy with another call, so nothing was typed; try the sign-in again once it is done"
                        : "The browser session's lock did not answer in time, so nothing was typed; try it again in a moment",
                success: false,
                ...(isSessionClosed && { sessionClosed: true }),
            },
            status: refused === "busy" ? 409 : 503,
        } as const;
    }

    // A hold that may lapse could let another call onto the session, before the cleanup took the password out of the
    // page: the browser is closed then, and the session with it.
    let isHoldLost = false;
    let isAnswered = false;
    const closeOnLost = (): void => {
        if (isHoldLost || isAnswered) {
            return;
        }

        isHoldLost = true;
        hold(endSession(browser, ready.isLaunched));
    };

    for (const held of holds.held) {
        held.onLost(closeOnLost);
    }

    const lostAnswer = (submitted: boolean | undefined) =>
        ({
            body: {
                error: "The hold on the browser session could not be kept for the sign-in, so the session is being closed; do not use it again",
                sessionCloseUnconfirmed: true,
                submitted,
                success: false,
            },
            status: 200,
        }) as const;

    // Lost while the browser was set up: nothing is typed into a session another call may already be on.
    if (isHoldLost) {
        return lostAnswer(false);
    }

    // Armed before anything is done on the page: from here a lapse of the hold retires the session. One the lock did
    // not answer starts nothing; should it have landed, a lapse of it still retires the session, the safe side.
    if (!(await holds.arm())) {
        isAnswered = true;
        await settledWithin(
            browser.close().catch(() => undefined),
            deadline - Date.now(),
        );

        return {
            body: {
                error: "The browser session's lock did not answer in time, so nothing was typed; try it again in a moment",
                success: false,
                ...(isSessionClosed && { sessionClosed: true }),
            },
            status: 503,
        } as const;
    }

    // A loss during the sign-in stops its next step (`isStopped`), the send included, without waiting for the close.
    const answer = await signInHeld(browser, page, {
        deadline,
        hold,
        isStopped: () => isHoldLost,
        opened,
        origin,
        password,
        ready,
        scan,
        scrub,
        url,
        username,
    });

    isAnswered = true;

    if (!isHoldLost) {
        return answer;
    }

    return lostAnswer("submitted" in answer.body ? answer.body.submitted : undefined);
};

const signInHeld = async (
    browser: Browser,
    page: import("@cloudflare/playwright").Page,
    {
        deadline,
        hold,
        isStopped,
        opened,
        origin,
        password,
        ready,
        scan,
        scrub,
        url,
        username,
    }: {
        deadline: number;
        hold: (closing: Promise<boolean>) => void;
        isStopped: () => boolean;
        opened: { sessionId: string } | undefined;
        origin: string;
        password: string;
        ready: { isLaunched: boolean; sessionId: string };
        scan: SecretScan;
        scrub: (error: unknown) => string;
        url: string;
        username: string;
    },
) => {
    let result: Awaited<ReturnType<typeof signIn>>;

    try {
        result = await signIn(page, { deadline, isStopped, navTimeout: NAV_TIMEOUT, origin, pageTimeout: PAGE_TIMEOUT, password, scan, url, username });
    } catch (error) {
        // Before anything was typed (`signIn` handles every error after): the session holds no password.
        // Its own reason, or a fixed text: a browser error can name what the page chose.
        return { body: { error: scrub(ownMessage(error)), sessionId: opened?.sessionId, success: false }, status: 500 } as const;
    }

    if (result.success || !result.sessionClosed) {
        return { body: { ...result, sessionId: ready.sessionId }, status: 200 } as const;
    }

    // Closed only once the browser says so: a close that fails or does not end in time leaves a session that may
    // still be open, which this isolate never lends out again.
    const closing = endSession(browser, ready.isLaunched);
    // Until the deadline, and at least `MIN_CLOSE_WAIT_MS` from the margin, but never into its last `RELEASE_MS`.
    const isClosed = await settledWithin(
        closing,
        Math.min(Math.max(MIN_CLOSE_WAIT_MS, deadline - Date.now()), deadline + LOGIN_MARGIN_MS - RELEASE_MS - Date.now()),
    );
    const reason = result.error.replace(TRAILING_STOP_RE, "");

    if (isClosed) {
        return { body: { ...result, error: `${reason}, so the browser session was closed` }, status: 200 } as const;
    }

    hold(closing);

    return {
        body: {
            ...result,
            error: `${reason}. The browser session could not be confirmed closed and may still be open, so do not use it again`,
            sessionClosed: undefined,
            sessionCloseUnconfirmed: true,
        },
        status: 200,
    } as const;
};

// Health check
app.get("/health", (c) => c.json({ service: "browser-renderer", status: "ok" }));

export default app;
