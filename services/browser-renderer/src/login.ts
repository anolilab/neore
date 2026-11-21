/**
 * Saved-login fill: the browser half of `/login`. Kept apart from the Worker so a test can drive it against a local
 * Chromium (`login.browser.test.ts`).
 */
import type { BrowserContext, CDPSession, Page, Request, Response, Route, WebSocketRoute } from "@cloudflare/playwright";

import type { ChannelLock } from "./channels";
import { lockChannels } from "./channels";

/** The exact origin of a URL (`URL#origin`: punycode host, default port dropped), or `null` when it has none. */
export const originOf = (url: string): string | null => {
    try {
        const { origin } = new URL(url);

        return origin === "null" ? null : origin;
    } catch {
        return null;
    }
};

/** `promise`, or `fallback` once `ms` passed: a page can keep any call waiting. */
const within = async <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
    Promise.race([
        promise,
        new Promise<T>((resolve) => {
            setTimeout(resolve, Math.max(0, ms), fallback);
        }),
    ]);

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

// ─── Stand-in ───────────────────────────────────────────────────────────────────

const STAND_IN_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** The shortest stand-in: no other text of a request matches it by chance, and it hides the length of most passwords. */
const STAND_IN_LENGTH = 64;

/** What the page is given in place of the password: `length` random letters and digits, never the password itself. */
export const standIn = (length: number, password: string): string => {
    let value = password;

    while (value === password) {
        value = [...crypto.getRandomValues(new Uint8Array(length))].map((byte) => STAND_IN_CHARACTERS[byte % STAND_IN_CHARACTERS.length]).join("");
    }

    return value;
};

const FORM_SAFE_RE = /[\w*.-]/;

/** `text` as `application/x-www-form-urlencoded` spells it, from its UTF-8 bytes. */
const formEncode = (text: string): string =>
    [...new TextEncoder().encode(text)]
        .map((byte) => {
            const character = String.fromCodePoint(byte);

            if (FORM_SAFE_RE.test(character)) {
                return character;
            }

            return byte === 0x20 ? "+" : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
        })
        .join("");

const BOUNDARY_RE = /boundary=(?:"([^"]+)"|([^\s;]+))/i;

const MULTIPART_NAME_RE = /["\n\r]/;

/**
 * The body of the form's POST with the password as the value of the field `name`, URL-encoded or multipart as the
 * browser encoded the form. `null`, so that nothing is sent, when that field does not hold the stand-in, when the
 * stand-in is anywhere else in the body (the page copied it into a field the site may keep or show), or when the body
 * has another encoding.
 */
export const withPassword = (body: Buffer, contentType: string, { name, stand }: { name: string; stand: string }, password: string): Buffer | null => {
    const at = body.indexOf(stand);

    if (at === -1 || body.includes(stand, at + 1)) {
        return null;
    }

    const type = contentType.split(";", 1)[0]?.trim().toLowerCase();

    if (type === "application/x-www-form-urlencoded") {
        const pairs = body.toString("latin1").split("&");
        const index = pairs.indexOf(`${formEncode(name)}=${stand}`);

        if (index === -1) {
            return null;
        }

        pairs[index] = `${formEncode(name)}=${formEncode(password)}`;

        return Buffer.from(pairs.join("&"), "latin1");
    }

    const boundary = type === "multipart/form-data" ? BOUNDARY_RE.exec(contentType) : null;

    if (!boundary || MULTIPART_NAME_RE.test(name)) {
        return null;
    }

    // A field's value sits between its part's headers and the next boundary.
    const spelled = (value: string): Buffer => Buffer.from(`name="${name}"\r\n\r\n${value}\r\n--${boundary[1] ?? boundary[2] ?? ""}`);
    const needle = spelled(stand);
    const from = body.indexOf(needle);

    return from === -1 ? null : Buffer.concat([body.subarray(0, from), spelled(password), body.subarray(from + needle.length)]);
};

// ─── Request guard ──────────────────────────────────────────────────────────────

const REDIRECT_KEEPING_BODY = new Set([307, 308]);

/** Whether a redirect would carry a request's body to another site: only a 307 or 308 does, and only of a request with one. */
const isRedirectElsewhere = (
    { hasBody, status, target }: { hasBody: boolean; status: number | undefined; target: string | null | undefined },
    origin: string,
): boolean => hasBody && target !== undefined && status !== undefined && REDIRECT_KEEPING_BODY.has(status) && target !== origin;

/** Whether `text` carries `secret`: in a form, URL, HTML or base64 spelling, or escaped as a JSON string. */
const hasSecret = (text: string, secret: string): boolean => text.includes(JSON.stringify(secret).slice(1, -1)) || withoutSecret(text, secret) !== text;

/**
 * Whether an address carries `secret` in its query or fragment, where a form sent by GET or a script puts it. Not the
 * path: a short password could be a word of the site's own paths.
 */
const hasSecretInAddress = (url: string, secret: string): boolean => {
    if (!URL.canParse(url)) {
        return hasSecret(url, secret);
    }

    const { hash, search } = new URL(url);

    return hasSecret(search + hash, secret);
};

/** Where a `Location` header points, against the address it answers; `null` (another site) when it does not parse. */
const redirectOrigin = (location: string, base: string): string | null => (URL.canParse(location, base) ? originOf(new URL(location, base).href) : null);

const WS_SCHEME_RE = /^ws/i;

/** The http(s) origin a `ws:` or `wss:` address talks to. */
const socketOrigin = (url: string): string | null => originOf(url.replace(WS_SCHEME_RE, "http"));

interface SocketGate {
    /** While a guard is armed: whether a new socket to `url` may open. */
    allows: ((url: string) => boolean) | null;
    /** While a guard is armed: told of each message a page sends on a socket the gate let through; `false` drops it. */
    onSend: ((message: string) => boolean) | null;
    open: Set<{ client: WebSocketRoute; server: WebSocketRoute }>;
}

const socketGates = new WeakMap<BrowserContext, Promise<SocketGate>>();

/**
 * Routes every WebSocket the context's pages open from here on through one handler, because request interception never
 * sees a socket: a guard can then refuse new ones and close open ones. Installed before the login page loads, so every
 * socket that page opens is one the gate knows. A socket the gate lets through talks to its server as before.
 */
const gateSockets = async (context: BrowserContext): Promise<SocketGate> => {
    let installed = socketGates.get(context);

    if (!installed) {
        const gate: SocketGate = { allows: null, onSend: null, open: new Set() };

        installed = context
            .routeWebSocket(
                () => true,
                async (socket) => {
                    if (gate.allows?.(socket.url()) === false) {
                        await socket.close().catch(() => undefined);

                        return;
                    }

                    const open = { client: socket, server: socket.connectToServer() };

                    // A side whose messages or close are handled here passes them on by hand.
                    open.client.onMessage((message) => {
                        if (gate.onSend?.(typeof message === "string" ? message : new TextDecoder().decode(message)) !== false) {
                            open.server.send(message);
                        }
                    });
                    open.client.onClose((code, reason) => {
                        gate.open.delete(open);
                        open.server.close({ code, reason }).catch(() => undefined);
                    });
                    open.server.onClose((code, reason) => {
                        gate.open.delete(open);
                        open.client.close({ code, reason }).catch(() => undefined);
                    });
                    gate.open.add(open);
                },
            )
            .then(() => gate)
            .catch((error: unknown) => {
                socketGates.delete(context);

                throw error;
            });
        socketGates.set(context, installed);
    }

    return installed;
};

/**
 * Blocks the tab's ways out of `origin` until `disarm()`, from before the stand-in is typed until the page is cleared:
 * only `page` itself may reach `origin`, every other request is aborted (another origin, any page the context opens, a
 * worker's or service worker's own request). The page holds only `stand`, never the password: after `expectSubmit()`,
 * the main frame's POST to `form.action` is sent with the password in place of the stand-in in the field `form.name`
 * (`withPassword`), with scripts turned off for the document it loads, so nothing the site shows of it can be read
 * (`sent()`). A POST elsewhere, or one whose stand-in is missing or also in another field, is not sent (`changed()`). Any other request or socket message that carries
 * the stand-in (a script read the field) is dropped, a script's fetch, XHR or socket message to `origin` as
 * `scripted()`: that sign-in cannot be filled. A 307 or 308 redirect of a request with a body, which would carry it on,
 * is failed when it points elsewhere or its `Location` does not parse; a new page (a popup) is closed; a WebSocket to
 * another origin is closed or refused; a worker, window or service worker `lock` stops, or a speculative load it sees,
 * counts as an attempt (the lock, set before the page loaded, refuses what interception does not see). Until the answer
 * to the form's own navigation arrives (the document that held the stand-in is being replaced; blocking goes on),
 * `attempt()` names the first blocked request that could have carried what the page has (a navigation, a body, a socket
 * or such a redirect). A guard that cannot be set up whole is taken down again before the error is thrown.
 */
/** Where the form sends the password: its action address, and the password field's name. */
interface FormTarget {
    action: string;
    name: string;
}

const withoutFragment = (url: string): string => url.split("#", 1)[0] ?? url;

const armGuard = async (
    page: Page,
    { form, lock, origin, password, stand }: { form: FormTarget; lock: ChannelLock; origin: string; password: string; stand: string },
) => {
    let isExpecting = false;
    let isCounting = true;
    let sent: Request | null = null;
    let isChanged = false;
    let isScripted = false;
    let attempt: string | null = null;

    /** A service worker's request has no frame: it is not the page's. */
    const frameOf = (request: Request) => {
        try {
            return request.frame();
        } catch {
            return null;
        }
    };

    const onRoute = async (route: Route): Promise<void> => {
        const request = route.request();
        const body = request.postDataBuffer();
        const isOwn = frameOf(request)?.page() === page && originOf(request.url()) === origin;

        if (hasSecretInAddress(request.url(), stand)) {
            attempt ??= "the password in an address";
        } else if (isExpecting && !sent && isOwn && request.isNavigationRequest() && request.method() === "POST" && frameOf(request) === page.mainFrame()) {
            const filled =
                body && withoutFragment(request.url()) === withoutFragment(form.action)
                    ? withPassword(body, request.headers()["content-type"] ?? "", { name: form.name, stand }, password)
                    : null;
            // The answer may show what was sent: no script of it runs, so none reads it or keeps it for later.
            const isShielded =
                filled !== null &&
                (await cdp
                    ?.send("Emulation.setScriptExecutionDisabled", { value: true })
                    .then(() => true)
                    .catch(() => false));

            if (filled && isShielded) {
                sent = request;
                await route.fallback({ postData: filled });

                return;
            }

            isChanged = true;
        } else if (isOwn && body?.includes(stand)) {
            isScripted ||= ["fetch", "xhr"].includes(request.resourceType());
        } else if (isOwn) {
            await route.fallback();

            return;
        } else if (isCounting && (body !== null || request.isNavigationRequest())) {
            attempt ??= `a request to ${originOf(request.url()) ?? "another site"}`;
        }

        await route.abort("blockedbyclient");
    };

    /** The final answer to the form's own navigation, after any redirects: what loads from here is the next page's. */
    const onResponse = (response: Response): void => {
        let request: Request | null = response.request();
        const status = response.status();

        if (!sent || (status >= 300 && status < 400)) {
            return;
        }

        while (request && request !== sent) {
            request = request.redirectedFrom();
        }

        if (request) {
            isCounting = false;
        }
    };

    const onPage = (opened: Page): void => {
        if (isCounting) {
            attempt ??= "a new window";
        }

        opened.close().catch(() => undefined);
    };

    let cdp: CDPSession | undefined;
    let gate: SocketGate | undefined;

    const disarm = async (): Promise<void> => {
        lock.onRefused(null);

        if (gate) {
            gate.allows = null;
            gate.onSend = null;
        }

        lock.route(null);
        page.context().off("page", onPage);
        page.off("response", onResponse);
        await cdp?.detach().catch(() => undefined);
    };

    try {
        lock.onRefused((what) => {
            if (isCounting) {
                attempt ??= what;
            }
        });
        lock.route(onRoute);
        page.context().on("page", onPage);
        page.on("response", onResponse);

        gate = await gateSockets(page.context());
        // The whole address of a socket: unlike a page's path, nothing of it is the site's own.
        gate.allows = (url) => {
            if (socketOrigin(url) === origin && !hasSecret(url, stand)) {
                return true;
            }

            if (isCounting) {
                attempt ??= `a WebSocket to ${socketOrigin(url) ?? "another site"}`;
            }

            return false;
        };

        // Only sockets to `origin` are open: one that carries the stand-in is a script's sign-in.
        gate.onSend = (message) => {
            if (!hasSecret(message, stand)) {
                return true;
            }

            isScripted = true;

            return false;
        };

        const elsewhere = [...gate.open].filter((socket) => socketOrigin(socket.client.url()) !== origin);

        for (const socket of elsewhere) {
            gate.open.delete(socket);
        }

        await within(
            Promise.all(elsewhere.flatMap(({ client, server }) => [client.close().catch(() => undefined), server.close().catch(() => undefined)])),
            1000,
            [],
        );

        cdp = await page.context().newCDPSession(page);

        const session = cdp;

        session.on("Fetch.requestPaused", (event) => {
            const location = event.responseHeaders?.find((header) => header.name.toLowerCase() === "location")?.value;
            const target = location === undefined ? undefined : redirectOrigin(location, event.request.url);

            if (isRedirectElsewhere({ hasBody: event.request.hasPostData === true, status: event.responseStatusCode, target }, origin)) {
                if (isCounting) {
                    attempt ??= `a redirect to ${target ?? "another site"}`;
                }

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
        /** Whether the final answer to the form's own navigation arrived. */
        answered: () => !isCounting,
        attempt: () => attempt,
        /** Whether the form's own POST went without the stand-in: the page changed the field, so it was not sent. */
        changed: () => isChanged,
        disarm,
        expectSubmit: (): void => {
            isExpecting = true;
        },
        /** Whether a script sent what it read from the field: such a sign-in is not one the stand-in can fill. */
        scripted: () => isScripted,
        /** Whether the form's own POST went out, with the password. */
        submitted: () => sent !== null,
    };
};

type Guard = Awaited<ReturnType<typeof armGuard>>;

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

    /**
     * `sessionClosed`: the page could not be made clean of the password within the hold, so the caller must close the
     * session. `submitted` can be true here: the sign-in went out before the step that failed, so it must not be resent.
     * `scriptSignIn`: the site signs in from a script that reads the field, which never holds the password: trying again
     * cannot help.
     */
    | { error: string; scriptSignIn?: true; sessionClosed?: true; submitted: boolean; success: false; url?: string };

/** Time a fill needs once it starts typing: the two fields, the submit, the wait for the next page and the cleanup. */
export const TYPE_RESERVE_MS = 12_000;

/** The end of the hold kept for the cleanup: no step before it runs into this time. */
const CLEANUP_MS = 4000;

/** The part of the cleanup's time kept for the look at the reloaded page. */
const CHECK_MS = 1000;

/** The end of the hold kept for closing the page when it cannot be cleared. */
const CLOSE_MS = 1000;

/** The longest wait for the form's request to go out, and then for the page it leads to. */
const SEND_WAIT_MS = 5000;

const ASCII_RE = /^[\u{20}-\u{7E}]*$/u;

const LINE_BREAK_RE = /[\n\r]/;

class OutOfTimeError extends Error {}

/**
 * Where the form `input` belongs to would send it (its default button's `formaction`/`formmethod`/`formtarget`/
 * `formenctype`, else the form's own), and, with `submit`, sends it with `requestSubmit`, which runs the page's own submit
 * handlers. Those handlers can still change where it goes; the request guard is what keeps it on `origin`. No method is
 * GET, which would put the password in the address: such a form is sent by POST. A form for another window is refused:
 * it would post from a page the guard does not watch. So is a `text/plain` form, and one in another charset than UTF-8
 * when the password is not ASCII (`isAscii`): the guard puts the password into URL-encoded or multipart UTF-8 only.
 */
const checkForm = (
    input: Element,
    { isAscii, origin, submit }: { isAscii: boolean; origin: string; submit: boolean },
): "encoding" | "no-form" | "off-site" | FormTarget => {
    const { form, isConnected, name, type } = input as HTMLInputElement;

    if (!form || !isConnected || type !== "password") {
        return "no-form";
    }

    const button = form.querySelector<HTMLButtonElement | HTMLInputElement>('button:not([type]), button[type="submit" i], input[type="submit" i]');
    const named = button?.getAttribute("formmethod") ?? form.getAttribute("method");
    const action = new URL(button?.getAttribute("formaction") ?? form.getAttribute("action") ?? "", document.baseURI);
    const target = (
        button?.getAttribute("formtarget") ??
        form.getAttribute("target") ??
        document.querySelector("base[target]")?.getAttribute("target") ??
        ""
    ).toLowerCase();

    if ((named ?? "post").toLowerCase() !== "post" || action.origin !== origin || !["", "_self"].includes(target)) {
        return "off-site";
    }

    const encoding = button?.hasAttribute("formenctype") ? button.formEnctype : form.enctype;
    // The first of `accept-charset`, else the document's own; spelled `UTF-8` or `utf8`.
    const charset = (form.acceptCharset.trim().split(" ", 1)[0] || document.characterSet).toLowerCase().replace("-", "");

    if (encoding === "text/plain" || (!isAscii && charset !== "utf8")) {
        return "encoding";
    }

    if (submit) {
        if (named === null) {
            form.setAttribute("method", "post");
        }

        form.requestSubmit(button ?? undefined);
    }

    return { action: action.href, name };
};

/** Whether any frame of the page has a password field. Throws when it cannot look. */
const hasPasswordField = async (page: Page): Promise<boolean> => {
    for (const frame of page.frames()) {
        if (await frame.$$eval('input[type="password" i]', (fields) => fields.length > 0)) {
            return true;
        }
    }

    return false;
};

/**
 * Whether no frame of the page shows `password` in any spelling: in a field, the markup or text (open shadow roots
 * included), the address, or the frame's storage and script-readable cookies, where a later read of the page or a
 * script could find it. Throws when it cannot look.
 */
const isClean = async (page: Page, password: string): Promise<boolean> => {
    for (const frame of page.frames()) {
        const texts = await frame.evaluate(() => {
            const found = [document.location.href, document.documentElement.outerHTML];
            // A stack, not a named inner function: a bundler that keeps names wraps one in a helper the page lacks.
            const roots: (Document | ShadowRoot)[] = [document];

            for (let root = roots.pop(); root; root = roots.pop()) {
                for (const field of root.querySelectorAll<HTMLInputElement>("input, textarea, select")) {
                    found.push(field.value);
                }

                for (const { shadowRoot } of root.querySelectorAll("*")) {
                    if (!shadowRoot) {
                        continue;
                    }

                    found.push(shadowRoot.getHTML());
                    roots.push(shadowRoot);
                }
            }

            // A sandboxed frame has no storage to read.
            try {
                for (const store of [localStorage, sessionStorage]) {
                    found.push(...Object.values(store));
                }

                found.push(document.cookie);
            } catch {
                // Nothing a script there can read either.
            }

            return found;
        });

        if (texts.some((text) => hasSecret(text, password))) {
            return false;
        }
    }

    return true;
};

/**
 * Takes the password out of the page before `deadline`: leaves the document that had it for `about:blank` while the
 * guard and the channel lock still hold (its `pagehide` and `unload` handlers run under them, and the workers it started
 * go with it), lifts both (`release`, which must end within a second), then, when the hold leaves time for it, loads the address again by GET, never resending the form, and looks
 * (`isClean`). An address that carries the password is not loaded again: the page stays blank, which is clean. Whether
 * the page is verifiably clean in time: when it is not, it must not be used again.
 */
const clearPassword = async (
    page: Page,
    {
        deadline,
        navTimeout,
        now,
        password,
        release,
    }: { deadline: number; navTimeout: number; now: () => number; password: string; release: () => Promise<void> },
): Promise<boolean> => {
    const address = page.url();

    try {
        if (now() >= deadline - CLOSE_MS) {
            return false;
        }

        await page.goto("about:blank", { timeout: deadline - CLOSE_MS - now() });
    } catch {
        return false;
    }

    // A lock still letting go would hold the next page's workers and WebRTC: the session is not handed back like that.
    if (
        !(await within(
            release().then(() => true),
            1000,
            false,
        ))
    ) {
        return false;
    }

    const reloadMs = deadline - CHECK_MS - now();

    if (reloadMs < 1000 || originOf(address) === null || hasSecret(address, password)) {
        return true;
    }

    try {
        await page.goto(address, { timeout: Math.min(navTimeout, reloadMs), waitUntil: "domcontentloaded" });
    } catch {
        return false;
    }

    return within(
        isClean(page, password).catch(() => false),
        deadline - now(),
        false,
    );
};

/**
 * Sign in with a saved login, in one call so nothing a page shows in between can steer it: open `url`, check the page is
 * on `origin` (after redirects, and again right before each field is typed), type the username into the text field
 * before the first visible password field of the main frame and the password into that password field only, and send
 * that field's own form, only by POST and only to `origin`, while every request elsewhere is blocked. Whatever happens
 * once the password is typed, the page leaves that document and is loaded again; when that cannot be confirmed clean
 * before `deadline` the page is closed and the result says the session must be closed. The URL, title and error are
 * scrubbed of the password. The steps before the cleanup end `CLEANUP_MS` before `deadline`, so the cleanup has its own
 * time inside the hold.
 */
export const signIn = async (page: Page, options: SignInOptions): Promise<SignInResult> => {
    const { deadline, navTimeout, now = Date.now, origin, pageTimeout, password, url, username } = options;
    const scrub = (text: string): string => withoutSecret(text, password);
    const isAscii = ASCII_RE.test(password);

    /** The time a step may take: never into the cleanup's time, and no step at all once that began. */
    const left = (cap: number): number => {
        const ms = deadline - CLEANUP_MS - now();

        if (ms <= 0) {
            throw new OutOfTimeError("The sign-in ran out of time");
        }

        return Math.min(cap, ms);
    };

    const offSite = (): string | null => {
        const at = originOf(page.url());

        return at === origin ? null : `The page left ${origin} (it is on ${at ?? "no site"})`;
    };

    let guard: Guard | undefined;
    let lock: ChannelLock | undefined;

    const failed = (error: string): Extract<SignInResult, { success: false }> => {
        const refused = guard ? null : lock?.refused();
        const why = refused ? `${error} (the page tried to start ${refused}, which is off while a saved login signs in, so it may not have loaded)` : error;

        return { error: scrub(why), submitted: Boolean(guard?.submitted()), success: false, url: scrub(page.url()) };
    };

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

        const form = await field.evaluate(checkForm, { isAscii, origin, submit: false });

        if (form === "no-form") {
            return "The password field is not in a form, so nothing was typed or sent";
        }

        if (form === "off-site") {
            return `The login form would not send the password to ${origin} by POST in this window, so nothing was typed`;
        }

        if (form === "encoding") {
            return "The login form encodes what it sends in a way the agent's browser cannot put a saved password into, so nothing was typed";
        }

        if (form.name === "") {
            return "The password field has no name, so its form would not send it; nothing was typed";
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

        return { field, target: form, user: userHandle.asElement() };
    };

    const attempt = async (): Promise<SignInResult> => {
        // A password field drops line breaks: the browser would never send one.
        if (LINE_BREAK_RE.test(password)) {
            return failed("The saved password has a line break, which a password field cannot hold, so nothing was typed");
        }

        // Before the page loads: each socket it opens is then one the guard can close, and no worker, window or WebRTC
        // connection of it runs past the lock.
        await gateSockets(page.context());

        const locked = await lockChannels(page);

        lock = locked;

        const found = await findFields();

        if (typeof found === "string") {
            return failed(found);
        }

        if (deadline - now() < TYPE_RESERVE_MS) {
            return failed("Too little time was left to sign in, so nothing was typed. Try it again.");
        }

        const { field, target, user } = found;

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

        // The browser sends a rule set's loads itself: one the page lock could not take out would carry what the page
        // puts in a link.
        if (await locked.speculates()) {
            return failed("The login page holds speculation rules that cannot be taken out, so the password was not typed");
        }

        const timeout = left(pageTimeout);

        // The page gets a stand-in, never the password: the guard puts the password into the form's own POST as it
        // leaves, so no script of the page (nor a request it makes the browser send) can read it.
        const maxLength = await field.evaluate((input) => (input as HTMLInputElement).maxLength);
        const longest = maxLength > 0 ? Math.max(maxLength, password.length) : Infinity;
        const stand = standIn(Math.min(Math.max(password.length, STAND_IN_LENGTH), longest), password);

        guard = await armGuard(page, { form: target, lock: locked, origin, password, stand });
        // One call sets the whole value: no keystroke can land after the hold.
        await field.fill(stand, { timeout });
        // A page with an unload listener is never kept in the back/forward cache, where the filled form would wait.
        await within(
            page.evaluate(() => window.addEventListener("unload", () => undefined)).catch(() => undefined),
            left(1000),
            undefined,
        );

        left(pageTimeout);
        guard.expectSubmit();

        // Listened for before the send: a fast server can have the next page loaded before the send returns.
        const nextPage = page
            .waitForEvent("domcontentloaded", { timeout: left(SEND_WAIT_MS * 2) })
            .then(() => true)
            .catch(() => false);

        // The page's submit handlers run inside this call: one that never returns must not hold it past the deadline.
        const form = await within<ReturnType<typeof checkForm> | "busy">(
            field.evaluate(checkForm, { isAscii, origin, submit: true }),
            left(pageTimeout),
            "busy",
        );

        if (form === "busy") {
            return failed("The page did not finish sending the form in time");
        }

        if (typeof form === "string") {
            return failed(`The login form changed to send the password elsewhere than ${origin} by POST, so it was not sent`);
        }

        const waitUntil = now() + left(SEND_WAIT_MS);

        while (!guard.submitted() && !guard.attempt() && !guard.changed() && !guard.scripted() && now() < waitUntil) {
            await page.waitForTimeout(100);
        }

        if (guard.submitted() && !guard.attempt()) {
            if (!(await nextPage)) {
                return failed("The site did not answer the sign-in in time");
            }

            // A page loaded with no answer to the form: the browser's error page.
            if (!guard.answered()) {
                return failed("The site's answer to the sign-in did not load");
            }
        }

        const blocked = guard.attempt();

        if (blocked) {
            return failed(`The page tried to send ${blocked} while the password was in it, so it was stopped`);
        }

        if (guard.submitted()) {
            return { passwordFieldRemains: false, submitted: true, success: true, title: "", url: "" };
        }

        if (guard.scripted()) {
            return { ...failed("This site signs in with a script the agent's browser cannot fill safely, so the password was not sent"), scriptSignIn: true };
        }

        return failed(
            guard.changed()
                ? "The page changed the password field before the form sent it, so the password was not sent"
                : "The login form was not sent: the page held it back",
        );
    };

    const result = await attempt().catch((error: unknown) => failed(error instanceof Error ? error.message : String(error)));

    // The guard is armed right before the password is typed: without it, the password never reached the page.
    if (!guard) {
        await within(lock?.release() ?? Promise.resolve(), 1000, undefined);

        return result;
    }

    const armed = guard;
    // Both, even when one of them hangs or fails.
    const release = async (): Promise<void> => {
        await Promise.allSettled([armed.disarm(), lock?.release()]);
    };

    // Read before the cleanup leaves the page, in the time the cleanup does not need: where the sign-in landed, and
    // whether it shows a password field again.
    const [title, passwordFieldRemains] = result.success
        ? await within(Promise.all([page.title().catch(() => ""), hasPasswordField(page).catch(() => true)]), Math.min(2000, deadline - CLEANUP_MS - now()), [
              "",
              true,
          ])
        : ["", false];
    const landedAt = scrub(page.url());

    // Whatever happened once the password was typed, it leaves the page before anything else can read the page.
    if (!(await clearPassword(page, { deadline, navTimeout, now, password, release }))) {
        // Closed before the lock lifts: a worker it holds would run once let go.
        await within(
            page
                .close()
                .catch(() => undefined)
                .then(release),
            CLOSE_MS,
            undefined,
        );

        return {
            error: "The password could not be cleared from the page in time, so the browser session was closed",
            sessionClosed: true,
            submitted: guard.submitted(),
            success: false,
        };
    }

    if (!result.success) {
        return result;
    }

    return { ...result, passwordFieldRemains, title: scrub(title), url: landedAt };
};
