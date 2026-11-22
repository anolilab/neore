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
import { connect, launch } from "@cloudflare/playwright";
import { Hono } from "hono";
import { z } from "zod";

import type { SecretScan } from "./login";
import { originOf, ownMessage, secretScan, signIn, TYPE_RESERVE_MS } from "./login";
import type { HoldKind, SessionHold } from "./session-lock";
import { holdSession, LEASE_MS } from "./session-lock";

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
    direction: z.enum(["up", "down"]).optional(),
    expectTarget: z.string().optional(), // click: the `target` of the element the person was shown; refused when it differs
    fullPage: z.boolean().optional(),
    selector: z.string().optional(),
    sessionId: z.string().optional(), // Reconnect to an existing browser session
    text: z.string().optional(),
    url: z.string().optional(),
    visibleOnly: z.boolean().optional(), // extract with a selector: the rendered text a person sees, not the raw textContent
});

/** Hoisted so they are compiled once, not on every request. */
const DIGITS_RE = /^\d+$/;

/** The longest accessible name the approval read returns; a longer one is cut and reported (`labelTruncated`). */
const LABEL_MAX_LENGTH = 15_000;

const WHITESPACE_RE = /\s+/u;

/** The click found another element, or this one with other text: the person's yes was for what they were shown. */
const TARGET_CHANGED = "The target changed since it was checked, so nothing was clicked. Look at the page again before you click.";

/**
 * Reads a control the way a click reaches it, in the page: `label`, its accessible name (capped; `labelTruncated` when cut),
 * and `target`, a fingerprint of the element (its place in the page, its name and its shown text). A click given that
 * `target` runs only on the element that still has it. The read is one function, so the check and the read agree.
 */
function readTarget(control: Element, options: { max: number; splitter: RegExp }): { label: string; labelTruncated: boolean; target: string } {
    // The elements the click lands in: the control, then each actionable ancestor up to the outermost. A visible child (an
    // icon in a button, a span in a clickable div) is clicked as those ancestors too.
    const actionableSelector =
        "button, a[href], [role='button'], [role='link'], [onclick], [tabindex]:not([tabindex='-1']), label, summary, input[type='button'], input[type='submit'], input[type='reset']";
    // The parent of an element, crossing a shadow root to its host: a button in a shadow tree is clicked as the host's ancestors too.
    const parentOf = (node: Element): Element | null => {
        if (node.parentElement !== null) {
            return node.parentElement;
        }

        const root = node.getRootNode();

        return root instanceof ShadowRoot ? root.host : null;
    };
    // Text the stylesheet draws, from CSS `content`: a quoted string. `none`, `normal` and counters are not text.
    // An element nothing is drawn for (display: none, visibility: hidden) shows none of its generated text either.
    const generatedText = (node: Element): string[] => {
        if (node.getClientRects().length === 0 || getComputedStyle(node).visibility === "hidden") {
            return [];
        }

        return ["::before", "::after"].flatMap((pseudo) => {
            const { content } = getComputedStyle(node, pseudo);
            const quote = content.charAt(0);

            return quote === '"' || quote === "'" ? [content.slice(1, -1)] : [];
        });
    };

    const nodes: Element[] = [control];

    for (let ancestor = parentOf(control); ancestor !== null; ancestor = parentOf(ancestor)) {
        if (ancestor.matches(actionableSelector) && !nodes.includes(ancestor)) {
            nodes.push(ancestor);
        }
    }

    const outermost = nodes.at(-1) ?? control;
    const names: string[] = [];

    for (const node of nodes) {
        names.push(node.getAttribute("aria-label") ?? "", node.getAttribute("title") ?? "");

        // Ids are separated by any ASCII whitespace, not only a space.
        const ids = (node.getAttribute("aria-labelledby") ?? "").split(options.splitter).filter(Boolean);

        for (const id of ids) {
            names.push((node.getRootNode() as Document).querySelector(`#${CSS.escape(id)}`)?.textContent ?? "");
        }

        // A submit-style button's value is its label. A text field's value is never read: a person may have typed into it.
        if (node instanceof HTMLInputElement && ["button", "reset", "submit"].includes(node.type)) {
            names.push(node.value);
        }

        // Text the stylesheet draws (CSS `content`) is on screen but in neither innerText nor textContent.
        names.push(...generatedText(node));

        // The rendered text: a child with ordinary text can sit beside a purchase word the person sees.
        if (node instanceof HTMLElement) {
            // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- rendered text on purpose: textContent keeps hidden descendants
            names.push(node.innerText);
        }
    }

    // Names that come from inside the outermost element: an image's alt, a child's aria-label or title, an SVG title.
    for (const node of outermost.querySelectorAll("img[alt], [aria-label], [title]")) {
        names.push(node.getAttribute("alt") ?? "", node.getAttribute("aria-label") ?? "", node.getAttribute("title") ?? "");
    }

    for (const node of outermost.querySelectorAll(":scope svg title")) {
        names.push(node.textContent ?? "");
    }

    // Generated text drawn by the elements inside the outermost one: a purchase word in a descendant's ::before is shown too.
    // Stops once the name is past its cap, which the read reports as cut short.
    let generatedLength = 0;

    for (const node of outermost.querySelectorAll("*")) {
        for (const text of generatedText(node)) {
            names.push(text);
            generatedLength += text.length;
        }

        if (generatedLength > options.max) {
            break;
        }
    }

    const joined = names.filter(Boolean).join(" ");
    const label = joined.slice(0, options.max);
    // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- the shown text on purpose: textContent keeps hidden descendants
    const shown = control instanceof HTMLElement ? control.innerText : (control.textContent ?? "");

    // The element's place: the tag and position of each ancestor, from the root down.
    const steps: string[] = [];
    let current: Element | null = control;

    while (current !== null && current !== document.documentElement) {
        const index = current.parentElement === null ? 0 : [...current.parentElement.children].indexOf(current);

        steps.unshift(`${current.localName}.${index}`);
        current = parentOf(current);
    }

    // FNV-1a over the three parts: a click compares the same string the read built.
    const fingerprintOf = [steps.join(">"), label, shown].join("\u{0}");
    let hash = 0x81_1c_9d_c5;

    for (const character of fingerprintOf) {
        hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 0x01_00_01_93);
    }

    return { label, labelTruncated: joined.length > options.max, target: `${(hash >>> 0).toString(16)}-${fingerprintOf.length}` };
}

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
    /** The control's accessible name when it is not its text (`visibleOnly` reads only): aria-label, labelled-by text, title, a submit button's value. */
    label?: string;
    labelTruncated?: boolean;
    screenshot?: string;
    screenshotFormat?: string;
    scrollPosition?: { maxY: number; x: number; y: number };
    success: boolean;
    /** The fingerprint of the extracted element (`visibleOnly` reads only), which a click can be checked against. */
    target?: string;
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

/** The session's page (a reconnected session keeps its page), guarded and with the default timeout. */
const pageOf = async (browser: import("@cloudflare/playwright").Browser): Promise<import("@cloudflare/playwright").Page> => {
    const page = browser.contexts()[0]?.pages()[0] ?? (await browser.newPage());

    page.setDefaultTimeout(PAGE_TIMEOUT);
    await guardPage(page);

    return page;
};

const BUSY_SIGNING_IN = "The browser session is signing in with a saved login; try again once that is done";

const BUSY_IN_USE = "The browser session is busy with another call; try the sign-in again once it is done";

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
    { action, direction, expectTarget, fullPage, selector, sessionId, text, url, visibleOnly }: z.infer<typeof actionSchema>,
    holds: ReturnType<typeof holdsOf>,
): Promise<Response> => {
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
        ({ browser, isLaunched, sessionId: activeSessionId } = await openBrowser(env, sessionId));
    } catch (error) {
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

        const page = await pageOf(browser);

        let result: ActionResult;

        switch (action) {
            case "click": {
                if (!selector) {
                    result = { error: "Selector is required for click action", success: false };
                    break;
                }

                if (expectTarget === undefined) {
                    await page.click(selector, { timeout: PAGE_TIMEOUT });
                } else {
                    // The element is held as a handle from the check to the click: a page change after the check moves
                    // nothing under it, and a different element (or the same one with other text) is refused.
                    const element = await page.$(selector);

                    if (!element) {
                        result = { error: `Element not found: ${selector}`, success: false };
                        break;
                    }

                    const read = await element.evaluate(readTarget, { max: LABEL_MAX_LENGTH, splitter: WHITESPACE_RE });

                    if (read.target !== expectTarget) {
                        result = { error: TARGET_CHANGED, success: false };
                        break;
                    }

                    await element.click({ timeout: PAGE_TIMEOUT });
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

                if (selector) {
                    const element = await page.$(selector);

                    if (!element) {
                        result = { error: `Element not found: ${selector}`, success: false };
                        break;
                    }

                    // `innerText` leaves out hidden descendants (display: none, visibility: hidden), so a purchase word
                    // the person cannot see does not count. An ordinary extract keeps the raw text it always returned.
                    // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- rendered text on purpose: textContent keeps hidden descendants
                    extractedText = visibleOnly === true ? await element.innerText() : ((await element.textContent()) ?? "");

                    if (visibleOnly === true) {
                        const read = await element.evaluate(readTarget, { max: LABEL_MAX_LENGTH, splitter: WHITESPACE_RE });

                        label = read.label;
                        isLabelTruncated = read.labelTruncated;
                        target = read.target;
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
    const refused = sessionId ? await holds.take(sessionId) : null;

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
