/**
 * Saved-login fill: the browser half of `/login`. Kept apart from the Worker so a test can drive it against a local
 * Chromium (`login.browser.test.ts`).
 */
import type { CDPSession, Page, Request, Route } from "@cloudflare/playwright";

/** The exact origin of a URL (`URL#origin`: punycode host, default port dropped), or `null` when it has none. */
export const originOf = (url: string): string | null => {
    try {
        const { origin } = new URL(url);

        return origin === "null" ? null : origin;
    } catch {
        return null;
    }
};

// ─── Scrubbing ──────────────────────────────────────────────────────────────────

const REGEXP_SPECIAL_RE = /[$()*+./?[\\\]^{|}-]/g;
const HEX_LETTER_RE = /[a-f]/g;

/** Hex digits of `value`, each letter in either case. */
const anyCaseHex = (value: number, width = 0): string =>
    value
        .toString(16)
        .padStart(width, "0")
        .replaceAll(HEX_LETTER_RE, (letter) => `[${letter}${letter.toUpperCase()}]`);

const NAMED_ENTITIES = new Map([
    ["&", "amp"],
    ["'", "apos"],
    ["<", "lt"],
    [">", "gt"],
    ['"', "quot"],
]);

/** Every spelling of one character a URL, a form body or HTML may give it: raw, `%xx` in either case, `+`, `&#…;`. */
const characterPattern = (character: string): string => {
    const code = character.codePointAt(0) ?? 0;
    const percent = [...new TextEncoder().encode(character)].map((byte) => `%${anyCaseHex(byte, 2)}`).join("");
    const spellings = [character.replaceAll(REGEXP_SPECIAL_RE, String.raw`\$&`), percent, `&#0*${code};`, `&#[xX]0*${anyCaseHex(code)};`];
    const named = NAMED_ENTITIES.get(character);

    if (character === " ") {
        spellings.push(String.raw`\+`);
    }

    if (named) {
        spellings.push(`&${named};`);
    }

    return `(?:${spellings.join("|")})`;
};

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCodePoint(...bytes));

/** A base64 character as a pattern: `+` and `/` also percent-encoded, as they are inside a URL. */
const BASE64_SPELLINGS = new Map([
    ["+", String.raw`(?:\+|%2[bB])`],
    ["/", "(?:/|%2[fF])"],
]);

/**
 * The base64 runs that spell `secret` wherever it sits in an encoded value, as one pattern: for each of the three byte
 * alignments, the characters fixed by the secret's bytes alone, in the standard and the URL alphabet. Runs under four
 * characters would match ordinary text, so they are left out; `null` when none is left.
 */
const base64Pattern = (secret: string): RegExp | null => {
    const bytes = new TextEncoder().encode(secret);
    const runs = new Set<string>();

    for (let shift = 0; shift < 3; shift++) {
        const padded = new Uint8Array(shift + bytes.length);

        padded.set(bytes, shift);

        const run = toBase64(padded).slice(Math.ceil((shift * 8) / 6), Math.floor(((shift + bytes.length) * 8) / 6));

        if (run.length >= 4) {
            runs.add([...run].map((character) => BASE64_SPELLINGS.get(character) ?? character).join(""));
            runs.add(run.replaceAll("+", "-").replaceAll("/", "_"));
        }
    }

    return runs.size === 0 ? null : new RegExp([...runs].join("|"), "g");
};

/** `text` with the password replaced in every spelling a page could echo it in: raw, URL- or form-encoded, HTML-escaped, base64 or base64url. */
export const withoutSecret = (text: string, secret: string): string => {
    const scrubbed = text.replaceAll(new RegExp([...secret].map((character) => characterPattern(character)).join(""), "g"), "[password]");
    const base64 = base64Pattern(secret);

    return base64 ? scrubbed.replaceAll(base64, "[password]") : scrubbed;
};

// ─── Request guard ──────────────────────────────────────────────────────────────

const REDIRECT_KEEPING_BODY = new Set([307, 308]);

const isRedirectElsewhere = (status: number | undefined, target: string | null | undefined, origin: string): boolean =>
    target !== undefined && status !== undefined && REDIRECT_KEEPING_BODY.has(status) && target !== origin;

/** Whether a request body carries `secret`: in a form or URL spelling, or escaped as a JSON string. */
const hasSecret = (body: string, secret: string): boolean => body.includes(JSON.stringify(secret).slice(1, -1)) || withoutSecret(body, secret) !== body;

/**
 * Blocks every way out of `origin` for the tab until `disarm()`, from before the password is typed until it is cleared:
 * every request to another origin is aborted (frames and popups too, as the route is the context's), a 307 or 308
 * redirect, which would carry a POST body on, is failed when it points elsewhere, and a new page (a popup) is closed.
 * `attempt()` names the first blocked request that could have carried the password (a navigation, a body or such a
 * redirect); `sent()` is the first request to `origin` after `expectSubmit()` that carries the password (the form's
 * own, or a script's that sends it). A guard that cannot be set up whole is taken down again before the error is thrown.
 */
const armGuard = async (page: Page, origin: string, password: string) => {
    let isExpecting = false;
    let sent: Request | null = null;
    let attempt: string | null = null;

    const onRoute = async (route: Route): Promise<void> => {
        const request = route.request();

        if (originOf(request.url()) === origin) {
            if (isExpecting && !sent && hasSecret(request.postData() ?? "", password)) {
                sent = request;
            }

            await route.fallback();

            return;
        }

        if (request.isNavigationRequest() || request.postDataBuffer() !== null) {
            attempt ??= `a request to ${originOf(request.url()) ?? "another site"}`;
        }

        await route.abort("blockedbyclient");
    };

    const onPage = (opened: Page): void => {
        attempt ??= "a new window";
        opened.close().catch(() => undefined);
    };

    let cdp: CDPSession | undefined;

    const disarm = async (): Promise<void> => {
        page.context().off("page", onPage);
        await page
            .context()
            .unroute("**/*", onRoute)
            .catch(() => undefined);
        await cdp?.detach().catch(() => undefined);
    };

    try {
        await page.context().route("**/*", onRoute);
        page.context().on("page", onPage);
        cdp = await page.context().newCDPSession(page);

        const session = cdp;

        session.on("Fetch.requestPaused", (event) => {
            const location = event.responseHeaders?.find((header) => header.name.toLowerCase() === "location")?.value;
            const target = location === undefined ? undefined : originOf(new URL(location, event.request.url).href);

            if (isRedirectElsewhere(event.responseStatusCode, target, origin)) {
                attempt ??= `a redirect to ${target ?? "another site"}`;
                session.send("Fetch.failRequest", { errorReason: "BlockedByClient", requestId: event.requestId }).catch(() => undefined);
            } else {
                session.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => undefined);
            }
        });
        await session.send("Fetch.enable", { patterns: [{ requestStage: "Response", urlPattern: "*" }] });
    } catch (error) {
        await disarm();

        throw error;
    }

    return {
        attempt: () => attempt,
        disarm,
        expectSubmit: (): void => {
            isExpecting = true;
        },
        sent: () => sent,
    };
};

// ─── Fill ───────────────────────────────────────────────────────────────────────

export interface SignInOptions {
    /** When the caller's hold ends (ms since the epoch, by `now`). */
    deadline: number;
    navTimeout: number;
    now?: () => number;
    origin: string;
    pageTimeout: number;
    password: string;
    url: string;
    username: string;
}

export type SignInResult =
    | { passwordFieldRemains: boolean; submitted: true; success: true; title: string; url: string }
    /** `sessionClosed`: the page could not be made clean of the password, so the caller must close the session. */
    | { error: string; sessionClosed?: true; submitted: false; success: false; url?: string };

/** Time a fill needs once it starts typing: the two fields, the submit, the wait for the next page and the cleanup. */
export const TYPE_RESERVE_MS = 10_000;

/** The longest wait for the form's request to go out, and then for the page it leads to. */
const SEND_WAIT_MS = 5000;

class OutOfTimeError extends Error {}

/**
 * Where the form `input` belongs to would send it (its default button's `formaction`/`formmethod`/`formtarget`, else
 * the form's own), and, with `submit`, sends it with `requestSubmit`, which runs the page's own submit handlers (a
 * script-driven sign-in needs them). Those handlers can still change where it goes; the request guard is what keeps it
 * on `origin`. No method is GET, which would put the password in the address: such a form is sent by POST. A form for
 * another window is refused: it would post from a page the guard does not watch.
 */
const checkForm = (input: Element, { origin, submit }: { origin: string; submit: boolean }): "no-form" | "off-site" | "ok" => {
    const { form, isConnected, type } = input as HTMLInputElement;

    if (!form || !isConnected || type !== "password") {
        return "no-form";
    }

    const button = form.querySelector<HTMLButtonElement | HTMLInputElement>('button:not([type]), button[type="submit" i], input[type="submit" i]');
    const named = button?.getAttribute("formmethod") ?? form.getAttribute("method");
    const action = new URL(button?.getAttribute("formaction") ?? form.getAttribute("action") ?? "", document.baseURI);
    const target = (button?.getAttribute("formtarget") ?? form.getAttribute("target") ?? "").toLowerCase();

    if ((named ?? "post").toLowerCase() !== "post" || action.origin !== origin || !["", "_self"].includes(target)) {
        return "off-site";
    }

    if (submit) {
        if (named === null) {
            form.setAttribute("method", "post");
        }

        form.requestSubmit(button ?? undefined);
    }

    return "ok";
};

/** Whether any field of any frame holds `password`, and whether any password field is on the page. Throws when it cannot look. */
const findPassword = async (page: Page, password: string) => {
    let isHeld = false;
    let hasPasswordField = false;

    for (const frame of page.frames()) {
        const states = await frame.$$eval(
            "input, textarea",
            (elements, secret) =>
                elements.map((element) => {
                    return { holds: (element as HTMLInputElement).value === secret, isPassword: (element as HTMLInputElement).type === "password" };
                }),
            password,
        );

        isHeld ||= states.some((state) => state.holds);
        hasPasswordField ||= states.some((state) => state.isPassword);
    }

    return { hasPasswordField, holds: isHeld };
};

/**
 * Takes the password out of the page: leaves the document that had it for `about:blank` while the guard still blocks
 * every other origin (no script of that document runs after), then loads the address again by GET, never resending the
 * form, when `timeout` leaves time for it, and looks: a field that holds the password again (a page that saved it) fails. Throws when the page is not
 * verifiably clean: it must not be used again. Whether a password field is on the page: the sign-in may have failed.
 */
const clearPassword = async (page: Page, password: string, timeout: number | null, guard: Awaited<ReturnType<typeof armGuard>>): Promise<boolean> => {
    const address = page.url();

    try {
        await page.goto("about:blank", { timeout: 5000 });
    } finally {
        await guard.disarm();
    }

    // No time left in the hold for the load: the page stays blank, which is clean.
    if (timeout === null || originOf(address) === null) {
        return false;
    }

    await page.goto(address, { timeout, waitUntil: "domcontentloaded" });

    const after = await findPassword(page, password);

    if (after.holds) {
        throw new Error("A field holds the password again");
    }

    return after.hasPasswordField;
};

/**
 * Sign in with a saved login, in one call so nothing a page shows in between can steer it: open `url`, check the page is
 * on `origin` (after redirects, and again right before each field is typed), type the username into the text field
 * before the first visible password field of the main frame and the password into that password field only, and send
 * that field's own form, only by POST and only to `origin`, while every request elsewhere is blocked. Whatever happens
 * once the password is typed, the page leaves that document and is loaded again; when that cannot be confirmed the
 * result says the session must be closed. The URL, title and error are scrubbed of the password. No step starts past
 * `deadline`.
 */
export const signIn = async (page: Page, options: SignInOptions): Promise<SignInResult> => {
    const { deadline, navTimeout, now = Date.now, origin, pageTimeout, password, url, username } = options;
    const scrub = (text: string): string => withoutSecret(text, password);

    /** The time a step may take: never past the deadline, and no step at all once it passed. */
    const left = (cap: number): number => {
        const ms = deadline - now();

        if (ms <= 0) {
            throw new OutOfTimeError("The sign-in ran out of time");
        }

        return Math.min(cap, ms);
    };

    const offSite = (): string | null => {
        const at = originOf(page.url());

        return at === origin ? null : `The page left ${origin} (it is on ${at ?? "no site"})`;
    };

    const failed = (error: string): SignInResult => {
        return { error: scrub(error), submitted: false, success: false, url: scrub(page.url()) };
    };

    let guard: Awaited<ReturnType<typeof armGuard>> | undefined;

    /** Opens the page and finds the fields; the password field, or why nothing will be typed. */
    const findFields = async () => {
        await page.goto(url, { timeout: left(navTimeout), waitUntil: "domcontentloaded" });

        const landed = offSite();

        if (landed) {
            return `${landed}, so nothing was typed`;
        }

        // The main frame only: a frame of another site is never typed into.
        const field = await page
            .locator('input[type="password"]:visible')
            .first()
            .elementHandle({ timeout: left(pageTimeout) })
            .catch(() => null);

        if (!field) {
            return "No password field is on the page";
        }

        const form = await field.evaluate(checkForm, { origin, submit: false });

        if (form === "no-form") {
            return "The password field is not in a form, so nothing was typed or sent";
        }

        if (form === "off-site") {
            return `The login form would not send the password to ${origin} by POST in this window, so nothing was typed`;
        }

        const userHandle = await field.evaluateHandle((input) => {
            const scope = (input as HTMLInputElement).form ?? document;
            const before = [...scope.querySelectorAll("input")].filter(
                (candidate) =>
                    ["", "email", "tel", "text"].includes(candidate.getAttribute("type")?.toLowerCase() ?? "") &&
                    candidate.getClientRects().length > 0 &&
                    Boolean(candidate.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING),
            );

            return before.at(-1) ?? null;
        });

        return { field, user: userHandle.asElement() };
    };

    const attempt = async (): Promise<SignInResult> => {
        const found = await findFields();

        if (typeof found === "string") {
            return failed(found);
        }

        if (deadline - now() < TYPE_RESERVE_MS) {
            return failed("Too little time was left to sign in, so nothing was typed. Try it again.");
        }

        const { field, user } = found;

        if (user) {
            await user.fill(username, { timeout: left(pageTimeout) });
        }

        const moved = offSite();

        if (moved) {
            return failed(`${moved}, so the password was not typed`);
        }

        if (!(await field.evaluate((input) => input.isConnected && (input as HTMLInputElement).type === "password"))) {
            return failed("The password field changed before it was typed into, so it was left empty");
        }

        const timeout = left(pageTimeout);

        guard = await armGuard(page, origin, password);
        // One call sets the whole value: no keystroke can land after the hold.
        await field.fill(password, { timeout });
        // A page with an unload listener is never kept in the back/forward cache, where the filled form would wait.
        await page.evaluate(() => window.addEventListener("unload", () => undefined)).catch(() => undefined);

        left(pageTimeout);
        guard.expectSubmit();

        // Listened for before the send: a fast server can have the next page loaded before the send returns.
        // eslint-disable-next-line unicorn/no-declarations-before-early-exit -- it must exist before the form is sent
        const nextPage = page.waitForEvent("domcontentloaded", { timeout: left(SEND_WAIT_MS * 2) }).catch(() => undefined);

        if ((await field.evaluate(checkForm, { origin, submit: true })) !== "ok") {
            return failed(`The login form changed to send the password elsewhere than ${origin} by POST, so it was not sent`);
        }

        const waitUntil = now() + Math.min(SEND_WAIT_MS, deadline - now());

        while (!guard.sent() && !guard.attempt() && now() < waitUntil) {
            await page.waitForTimeout(100);
        }

        const sent = guard.sent();

        if (sent && !guard.attempt()) {
            // The form's own navigation: the page it leads to. A script's request: its answer, then a moment for what the
            // script does with it.
            if (sent.isNavigationRequest()) {
                await nextPage;
            } else {
                await sent.response().catch(() => undefined);
                await page.waitForTimeout(Math.min(1500, Math.max(0, deadline - now())));
            }
        }

        const blocked = guard.attempt();

        if (blocked) {
            return failed(`The page tried to send ${blocked} while the password was in it, so it was stopped`);
        }

        return sent
            ? { passwordFieldRemains: false, submitted: true, success: true, title: "", url: "" }
            : failed("The login form was not sent: the page held it back");
    };

    const result = await attempt().catch((error: unknown) => failed(error instanceof Error ? error.message : String(error)));

    // The guard is armed right before the password is typed: without it, the password never reached the page.
    if (!guard) {
        return result;
    }

    const title = result.success ? scrub(await page.title().catch(() => "")) : "";
    const landedAt = scrub(page.url());

    // Whatever happened once the password was typed, it leaves the page before anything else can read the page.
    const reloadMs = deadline - now();
    let hasPasswordField: boolean;

    try {
        hasPasswordField = await clearPassword(page, password, reloadMs > 1000 ? Math.min(navTimeout, reloadMs) : null, guard);
    } catch {
        return {
            error: "The password could not be cleared from the page, so the browser session was closed",
            sessionClosed: true,
            submitted: false,
            success: false,
        };
    }

    if (!result.success) {
        return result;
    }

    return { ...result, passwordFieldRemains: hasPasswordField, title, url: landedAt };
};
