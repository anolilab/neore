/**
 * Saved-login fill: the browser half of `/login`. Kept apart from the Worker so a test can drive it against a local
 * Chromium (`login.browser.test.ts`).
 */
import type { BrowserContext, CDPSession, Page, Request, Response, Route, WebSocketRoute } from "@cloudflare/playwright";

import type { ChannelLock } from "./channels";
import { lockChannels } from "./channels";
import type { FormTarget } from "./served-form";
import { AMBIGUOUS, MAX_SERVED_BYTES, servedForms, servedTarget } from "./served-form";

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

/** `text` with `secret` replaced in each spelling `characterPattern` and `base64Pattern` know, one layer deep: `hasSecret` reads the deeper ones. */
const replaceSecret = (text: string, secret: string): string => {
    const scrubbed = text.replaceAll(new RegExp([...secret].map((character) => characterPattern(character)).join(""), "g"), "[password]");
    const base64 = base64Pattern(secret);

    return base64 ? scrubbed.replaceAll(base64, "[password]") : scrubbed;
};

const PERCENT_RUN_RE = /(?:%[\da-f]{2})+/gi;

/**
 * How many layers of percent-encoding are taken off: past them, a text is taken to hold the password. A site that echoes
 * what it was sent encodes it once more each time; no page of a site is read through that many.
 */
const MAX_DECODE_ROUNDS = 32;

/**
 * How many characters the layers of a text may take to read through, as times its length, at least
 * `MIN_DECODE_BUDGET`: each layer is scanned whole, and a scan costs more the longer the password. A large page is read
 * through as many layers as a fixed depth of four spent; one with more is taken to hold the password.
 */
const DECODE_BUDGET_FACTOR = 5;

const MIN_DECODE_BUDGET = 1_000_000;

const UTF8 = new TextDecoder();

/** A run of escapes as text, from its UTF-8 bytes; a byte that is no UTF-8 reads as U+FFFD, so it hides no other. */
const decodeRun = (run: string): string => {
    // Most runs are one escape: the decoder's call costs more than it does. A lone byte past ASCII is no UTF-8.
    if (run.length === 3) {
        const byte = Number.parseInt(run.slice(1), 16);

        return byte < 0x80 ? String.fromCodePoint(byte) : "\u{FFFD}";
    }

    const bytes = new Uint8Array(run.length / 3);

    for (let index = 0; index < bytes.length; index++) {
        bytes[index] = Number.parseInt(run.slice(index * 3 + 1, index * 3 + 3), 16);
    }

    return UTF8.decode(bytes);
};

/**
 * Whether `text` carries `secret`: in a form, URL, HTML or base64 spelling, escaped as a JSON string, or under any
 * number of further layers of percent-encoding, each read in turn until one changes nothing. Each run of escapes is
 * decoded alone, so a stray `%` elsewhere (a "100%") does not stop the rest from being read. A text with more layers
 * than `MAX_DECODE_ROUNDS` or its budget reaches is taken to carry it.
 */
const hasSecret = (text: string, secret: string): boolean => {
    const escaped = JSON.stringify(secret).slice(1, -1);
    let budget = Math.max(MIN_DECODE_BUDGET, DECODE_BUDGET_FACTOR * text.length);
    let decoded = text;

    for (let round = 0; round <= MAX_DECODE_ROUNDS && budget >= decoded.length; round++) {
        budget -= decoded.length;

        if (decoded.includes(escaped) || replaceSecret(decoded, secret) !== decoded) {
            return true;
        }

        const next = decoded.replaceAll(PERCENT_RUN_RE, (run) => decodeRun(run));

        if (next === decoded) {
            return false;
        }

        decoded = next;
    }

    return true;
};

/**
 * `text` with the password replaced in every spelling a page could echo it in: raw, URL- or form-encoded, HTML-escaped,
 * base64 or base64url. A text that still carries it after that, at any depth of percent-encoding, is withheld whole.
 */
export const withoutSecret = (text: string, secret: string): string => {
    const scrubbed = replaceSecret(text, secret);

    return hasSecret(scrubbed, secret) ? "[withheld: it holds the password]" : scrubbed;
};

// ─── Stand-in ───────────────────────────────────────────────────────────────────

const STAND_IN_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** The shortest stand-in: no other text of a request matches it by chance, and it hides the length of most passwords. */
const STAND_IN_LENGTH = 64;

/** The low six bits of a random byte: a uniform pick from 64, of which the alphabet's 62 are kept. */
const SIX_BITS = 0b11_1111;

/**
 * What the page is given in place of the password: `length` random letters and digits, each as likely as any other
 * (a byte's low six bits, drawn again when they fall past the alphabet), never the password itself.
 */
export const standIn = (length: number, password: string): string => {
    let value = password;

    while (value === password) {
        value = "";

        while (value.length < length) {
            const bytes = crypto.getRandomValues(new Uint8Array(length));

            for (const byte of bytes) {
                const character = STAND_IN_CHARACTERS[byte & SIX_BITS];

                if (character !== undefined && value.length < length) {
                    value += character;
                }
            }
        }
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

/**
 * The largest request body the guard looks into: a login form's POST is far smaller. One larger, the form's own or
 * another request to `origin`, is aborted without being scanned or copied again while the guard holds.
 */
export const MAX_GUARDED_BODY_BYTES = 1024 * 1024;

/** Whether a redirect would carry a request's body to another site: only a 307 or 308 does, and only of a request with one. */
const isRedirectElsewhere = (
    { hasBody, status, target }: { hasBody: boolean; status: number | undefined; target: string | null | undefined },
    origin: string,
): boolean => hasBody && target !== undefined && status !== undefined && REDIRECT_KEEPING_BODY.has(status) && target !== origin;

/**
 * Whether an address carries `secret` in its query, fragment or user info, where a form sent by GET, a script or a
 * server's redirect puts it. Not the path: a short password could be a word of the site's own paths.
 */
const hasSecretInAddress = (url: string, secret: string): boolean => {
    if (!URL.canParse(url)) {
        return hasSecret(url, secret);
    }

    const address = new URL(url);

    return [address.username, address.password, address.search + address.hash].some((part) => hasSecret(part, secret));
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
 * (`sent()`). Only the first such POST can be sent: it is claimed before anything is awaited, and any later one is
 * not. A POST elsewhere, or one whose stand-in is missing or also in another field, is not sent (`changed()`); nor is one
 * whose answer the scripts could not be turned off for (`unshielded()`), one over `MAX_GUARDED_BODY_BYTES`
 * (`oversized()`), or one encoded otherwise than `form.enctype` (`reencoded()`). `disarm()` turns the scripts back on. Any other request or socket message that carries
 * the stand-in (a script read the field) is dropped, a script's fetch, XHR or socket message to `origin` as
 * `scripted()`: that sign-in cannot be filled. A 307 or 308 redirect of a request with a body, which would carry it on,
 * is failed when it points elsewhere or its `Location` does not parse; a new page (a popup) is closed; a WebSocket to
 * another origin is closed or refused; a worker, window or service worker `lock` stops, or a speculative load it sees,
 * counts as an attempt (the lock, set before the page loaded, refuses what interception does not see). Until the answer
 * to the form's own navigation arrives (the document that held the stand-in is being replaced; blocking goes on),
 * `attempt()` names the first blocked request that could have carried what the page has (a navigation, a body, a socket
 * or such a redirect). A guard that cannot be set up whole is taken down again before the error is thrown.
 */
const withoutFragment = (url: string): string => url.split("#", 1)[0] ?? url;

const armGuard = async (
    page: Page,
    { form, lock, origin, password, stand }: { form: FormTarget; lock: ChannelLock; origin: string; password: string; stand: string },
) => {
    let isExpecting = false;
    let isCounting = true;
    let isClaimed = false;
    let sent: Request | null = null;
    /** The claimed POST while it is handed on: its answer can arrive before the hand-on returns. */
    let forwarding: Request | null = null;
    let isReencoded = false;
    let isShielded = false;
    let isChanged = false;
    let isUnshielded = false;
    let isUnsent = false;
    let isOversized = false;
    let isScripted = false;
    let attempt: string | null = null;
    let admitted: string | null = null;
    let answerStatus = 0;

    /** A service worker's request has no frame: it is not the page's. */
    const frameOf = (request: Request) => {
        try {
            return request.frame();
        } catch {
            return null;
        }
    };

    let cdp: CDPSession | undefined;

    const shield = async (): Promise<boolean> => {
        if (!cdp) {
            return false;
        }

        // Set before the command: one that stalls may still take effect.
        isShielded = true;

        return cdp
            .send("Emulation.setScriptExecutionDisabled", { value: true })
            .then(() => true)
            .catch(() => false);
    };

    /**
     * Whether an address carries what the page holds, or, once the form's POST is claimed, the password: a site that
     * echoes it into a redirect's `Location` would have the browser put it in the address and send it again by GET. From
     * the claim, not from `sent`: the answer can arrive while the POST is still being handed on.
     */
    const isSecretAddress = (url: string): boolean => hasSecretInAddress(url, stand) || (isClaimed && hasSecretInAddress(url, password));

    const onRoute = async (route: Route): Promise<void> => {
        const request = route.request();
        // The buffer Playwright already holds, not a further copy; one over `MAX_GUARDED_BODY_BYTES` is neither scanned nor rewritten.
        const body = request.postDataBuffer();
        const isLarge = body !== null && body.length > MAX_GUARDED_BODY_BYTES;
        const isOwn = frameOf(request)?.page() === page && originOf(request.url()) === origin;
        const isAdmitted = body === null && request.url() === admitted && request.isNavigationRequest() && frameOf(request) === page.mainFrame();

        if (isSecretAddress(request.url())) {
            attempt ??= "the password in an address";
        } else if (
            isExpecting &&
            !isClaimed &&
            isOwn &&
            request.isNavigationRequest() &&
            request.method() === "POST" &&
            frameOf(request) === page.mainFrame()
        ) {
            // Claimed before anything is awaited: a second submission that arrives meanwhile is never the one sent.
            isClaimed = true;

            const contentType = request.headers()["content-type"] ?? "";
            const filled =
                body && !isLarge && withoutFragment(request.url()) === withoutFragment(form.action)
                    ? withPassword(body, contentType, { name: form.name, stand }, password)
                    : null;

            // The answer may show what was sent: no script of it runs, so none reads it or keeps it for later. A sign-in
            // given up while that command was on its way is not sent: its result already says so.
            if (isLarge) {
                isOversized = true;
            } else if ((contentType.split(";", 1)[0] ?? "").trim().toLowerCase() !== form.enctype) {
                // Encoded otherwise than the form the site served: a submit handler changed it.
                isReencoded = true;
            } else if (filled === null) {
                isChanged = true;
            } else if (!(await shield())) {
                isUnshielded = true;
            } else if (isExpecting) {
                try {
                    // It rejects only for a route already handled, when nothing is handed on. Once it resolves, the
                    // request goes on when this handler returns, and whether it reaches the site is unknown: that counts
                    // as sent, so the sign-in is never sent again.
                    forwarding = request;
                    await route.fallback({ postData: filled });
                    sent = request;

                    return;
                } catch {
                    forwarding = null;
                    isUnsent = true;
                }
            }
        } else if (isOwn && (isLarge || body?.includes(stand))) {
            // A body too large to look into is aborted unread.
            isScripted ||= !isLarge && ["fetch", "xhr"].includes(request.resourceType());
        } else if (isOwn || isAdmitted) {
            await route.fallback();

            return;
        } else if (isCounting && (body !== null || request.isNavigationRequest())) {
            attempt ??= `a request to ${originOf(request.url()) ?? "another site"}`;
        }

        await route.abort("blockedbyclient").catch(() => undefined);
    };

    /** The final answer to the form's own navigation, after any redirects: what loads from here is the next page's. */
    const onResponse = (response: Response): void => {
        let request: Request | null = response.request();
        const status = response.status();

        const claimed = sent ?? forwarding;

        if (!claimed || (status >= 300 && status < 400)) {
            return;
        }

        while (request && request !== claimed) {
            request = request.redirectedFrom();
        }

        if (request) {
            isCounting = false;
            answerStatus = status;
        }
    };

    const onPage = (opened: Page): void => {
        if (isCounting) {
            attempt ??= "a new window";
        }

        opened.close().catch(() => undefined);
    };

    let gate: SocketGate | undefined;

    /**
     * Takes the guard down. Whether the tab's scripts are confirmed back on: false when they were turned off and the
     * command that turns them on again failed or did not answer within a second, so the page must not be used again.
     */
    const disarm = async (): Promise<boolean> => {
        lock.onRefused(null);

        if (gate) {
            gate.allows = null;
            gate.onSend = null;
        }

        lock.route(null);
        page.context().off("page", onPage);
        page.off("response", onResponse);

        const session = cdp;
        const isRunning =
            !isShielded ||
            (session !== undefined &&
                (await within(
                    session
                        .send("Emulation.setScriptExecutionDisabled", { value: false })
                        .then(() => true)
                        .catch(() => false),
                    1000,
                    false,
                )));

        await session?.detach().catch(() => undefined);

        return isRunning;
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

            if (location !== undefined && isSecretAddress(URL.canParse(location, event.request.url) ? new URL(location, event.request.url).href : location)) {
                attempt ??= "the password in an address";
                session.send("Fetch.failRequest", { errorReason: "BlockedByClient", requestId: event.requestId }).catch(() => undefined);
            } else if (isRedirectElsewhere({ hasBody: event.request.hasPostData === true, status: event.responseStatusCode, target }, origin)) {
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
        /** Lets the main frame load `url` by GET, wherever it is: the cleanup's reload of the page the sign-in landed on. */
        admit: (url: string): void => {
            admitted = url;
        },
        /** Whether the final answer to the form's own navigation arrived. */
        answered: () => !isCounting,
        /** The HTTP status of that answer, 0 before it arrived. */
        answerStatus: () => answerStatus,
        attempt: () => attempt,
        /** Whether the form's own POST went without the stand-in: the page changed the field, so it was not sent. */
        changed: () => isChanged,
        disarm,
        expectSubmit: (): void => {
            isExpecting = true;
        },
        /** Ends the wait for the form's POST: one that arrives later, or is still waiting on the scripts going off, is not sent. */
        giveUp: (): void => {
            isExpecting = false;
        },
        /** Whether the form's own POST was over `MAX_GUARDED_BODY_BYTES`: it was not read or sent. */
        oversized: () => isOversized,
        /** Whether the form's own POST was encoded otherwise than the form the site served: it was not sent. */
        reencoded: () => isReencoded,
        /** Whether a script sent what it read from the field: such a sign-in is not one the stand-in can fill. */
        scripted: () => isScripted,
        /** Turns the tab's scripts off until the guard is taken down; false when that cannot be confirmed. */
        shield,
        /** Whether the form's own POST was handed on with the password: it may have reached the site, so it is never resent. */
        submitted: () => sent !== null,
        /** Whether the form's own POST could not be handed on: it was not sent. */
        unsent: () => isUnsent,
        /** Whether the form's own POST was held because the tab's scripts could not be turned off for its answer. */
        unshielded: () => isUnshielded,
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
     * session and say so after `error`. `submitted` can be true here: the sign-in went out before the step that failed,
     * so it must not be resent.
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
 * Where the form `input` belongs to would send it (the `formaction`/`formmethod`/`formtarget`/`formenctype` of its first
 * enabled submit button, else the form's own), and, with `expected`, sends it with `requestSubmit` from that button, which runs the page's own submit
 * handlers. A form whose encoding or `accept-charset` is not `expected` (the form the site served) before or after those
 * handlers is not sent (`re-encoded`). Those handlers can still change where it goes; the request guard is what keeps it on `origin`. No method is
 * GET, which would put the password in the address: such a form is sent by POST. A form for another window (any target
 * but this one, `_parent` and `_top` only when it is the top window) is refused: it would post from a page the guard does
 * not watch. So is a `text/plain` form, and one in another charset than UTF-8
 * when the password is not ASCII (`isAscii`): the guard puts the password into URL-encoded or multipart UTF-8 only.
 */
const checkForm = (
    input: Element,
    { expected, isAscii, origin }: { expected?: { charset: string; enctype: string }; isAscii: boolean; origin: string },
): "encoding" | "no-form" | "off-site" | "re-encoded" | FormTarget => {
    const { form, isConnected, name, type } = input as HTMLInputElement;

    if (!form || !isConnected || type !== "password") {
        return "no-form";
    }

    // Read through the prototypes: a control named `enctype`, `acceptCharset` or `requestSubmit` hides the form's own,
    // and a form or image named `URL` or `querySelectorAll` the document's. No helper function: a bundler that keeps
    // names wraps one in a helper the page lacks.
    const { getAttribute, setAttribute } = Element.prototype;
    const { acceptCharset, enctype } = Object.getOwnPropertyDescriptors(HTMLFormElement.prototype);
    const { characterSet, defaultView, URL: address } = Object.getOwnPropertyDescriptors(Document.prototype);
    const baseUri = Object.getOwnPropertyDescriptor(Node.prototype, "baseURI");

    // The first enabled submit button whose form this is, wherever it sits (a `form` attribute): an image input is one,
    // and a button of no known type is a submit button. A disabled one cannot send the form.
    const button =
        [...(Document.prototype.querySelectorAll.call(document, "button, input") as NodeListOf<HTMLButtonElement | HTMLInputElement>)].find(
            (control) => control.form === form && ["image", "submit"].includes(control.type) && !control.matches(":disabled"),
        ) ?? null;
    const named = button?.getAttribute("formmethod") ?? getAttribute.call(form, "method");
    const written = button?.getAttribute("formaction") ?? getAttribute.call(form, "action") ?? "";
    // An empty action is the document's own address, whatever its base.
    const action = new URL(written === "" ? (address?.get?.call(document) as string) : written, baseUri?.get?.call(document) as string);

    action.hash = "";
    const base = Document.prototype.querySelector.call(document, "base[target]");
    const target = (
        button?.getAttribute("formtarget") ??
        getAttribute.call(form, "target") ??
        (base ? getAttribute.call(base, "target") : null) ??
        ""
    ).toLowerCase();

    // `_parent` and `_top` name this window when it is the top one, as the main frame's always is.
    const view = defaultView?.get?.call(document) as Window | null;
    const sameWindow = view?.top === view ? ["", "_parent", "_self", "_top"] : ["", "_self"];

    if ((named ?? "post").toLowerCase() !== "post" || action.origin !== origin || !sameWindow.includes(target)) {
        return "off-site";
    }

    const encoding = button?.hasAttribute("formenctype") ? button.formEnctype : (enctype?.get?.call(form) as string);
    // The first of `accept-charset`, else the document's own; spelled `UTF-8` or `utf8`.
    const charset = ((acceptCharset?.get?.call(form) as string).trim().split(" ", 1)[0] || (characterSet?.get?.call(document) as string))
        .toLowerCase()
        .replace("-", "");

    if (encoding === "text/plain" || (!isAscii && charset !== "utf8")) {
        return "encoding";
    }

    const accepted = getAttribute.call(form, "accept-charset") ?? "";

    if (expected && (encoding !== expected.enctype || accepted !== expected.charset)) {
        return "re-encoded";
    }

    if (expected) {
        // Read before the page's submit handlers run, which could replace it.
        const stop = view ? (Object.getOwnPropertyDescriptor(view, "stop")?.value as (() => void) | undefined) : undefined;

        if (named === null) {
            setAttribute.call(form, "method", "post");
        }

        HTMLFormElement.prototype.requestSubmit.call(form, button ?? undefined);

        // The submission reads the encoding once the page's submit handlers are done, as here: one that changed it has
        // its navigation stopped before it starts.
        const sentEncoding = button?.hasAttribute("formenctype") ? button.formEnctype : (enctype?.get?.call(form) as string);

        if (sentEncoding !== expected.enctype || (getAttribute.call(form, "accept-charset") ?? "") !== expected.charset) {
            stop?.call(view);

            return "re-encoded";
        }
    }

    return {
        action: action.href,
        charset: accepted,
        enctype: encoding,
        method: (named ?? "post").toLowerCase(),
        name,
        target,
    };
};

/** What the site answered a document load with: enough to read its body and where it came from. */
interface Answer {
    requestId: string;
    response: { fromServiceWorker?: boolean; mimeType: string; url: string };
}

/**
 * Loads `url` in the main frame of `page`, until its `DOMContentLoaded` or `timeout`, past the HTTP cache, and keeps hold
 * of that load. `served()` is then the HTML the site sent for it, as the network delivered it and the browser decoded it,
 * read over the DevTools protocol where no script of the page reaches, with its address: `null` when the page no longer
 * shows the document that load committed (a script navigated it away), a redirect of it passed through another origin
 * than `origin`, a service worker answered, it is not `text/html`, or its body is not kept (over `MAX_SERVED_BYTES`,
 * which the browser then drops, or gone) or not text the browser decoded. Every command of the load ends by `timeout`.
 * Throws when the load fails; `detach(ms)` lets go of it, `false` when that did not end within `ms` (the session may
 * still hold it).
 */
const loadServed = async (page: Page, { now, origin, timeout, url }: { now: () => number; origin: string; timeout: number; url: string }) => {
    const until = now() + timeout;
    /** `promise`, or the load given up once its time is out. */
    const inTime = async <T>(promise: Promise<T>): Promise<T> => {
        const settled = await within(
            promise.then((value) => {
                return { value };
            }),
            until - now(),
            null,
        );

        if (!settled) {
            throw new Error("The login page did not load in time");
        }

        return settled.value;
    };
    let isLate = false;
    const opening = page.context().newCDPSession(page);

    // One that opens late is let go of as it opens.
    opening.then(async (opened) => (isLate ? opened.detach() : undefined)).catch(() => undefined);

    const session = await inTime(opening).catch((error: unknown) => {
        isLate = true;

        throw error;
    });
    const answers = new Map<string, Answer>();
    // Loads that asked another origin on the way, by a redirect: that hop chose the page.
    const strayed = new Set<string>();

    session.on("Network.requestWillBeSent", ({ loaderId, request, type }) => {
        if (type === "Document" && originOf(request.url) !== origin) {
            strayed.add(loaderId);
        }
    });
    session.on("Network.responseReceived", ({ loaderId, requestId, response, type }) => {
        if (type === "Document") {
            answers.set(loaderId, { requestId, response });
        }
    });

    const detach = async (ms: number): Promise<boolean> =>
        within(
            session
                .detach()
                .then(() => true)
                .catch(() => false),
            ms,
            false,
        );

    let loaderId: string | undefined;
    let stopAt: number | undefined;

    try {
        await inTime(session.send("Network.enable", { maxResourceBufferSize: MAX_SERVED_BYTES, maxTotalBufferSize: MAX_SERVED_BYTES * 4 }));
        // A response a script of the site had cached (with headers of its own choosing) is not the site's answer to this load.
        await inTime(session.send("Network.setCacheDisabled", { cacheDisabled: true }));

        const loaded = page
            .waitForEvent("domcontentloaded", { timeout: Math.max(1, until - now()) })
            .then(() => true)
            .catch(() => false);
        const navigated = await within(session.send("Page.navigate", { url }), until - now(), null);

        if (!navigated) {
            stopAt = now() + CLOSE_MS;
            await within(
                session.send("Page.stopLoading").catch(() => undefined),
                CLOSE_MS,
                undefined,
            );

            throw new Error("The login page did not load in time");
        }

        loaderId = navigated.loaderId;

        // No loader: a navigation within the document the tab already shows, whose HTML was not sent for this load.
        if (loaderId === undefined || navigated.errorText) {
            throw new Error(`The login page did not load${navigated.errorText ? ` (${navigated.errorText})` : ""}`);
        }

        if (!(await loaded)) {
            throw new Error("The login page did not load in time");
        }
    } catch (error) {
        // Stopping the load and letting go of it share one second, the part of the cleanup's time a failed load takes.
        await detach((stopAt ?? now() + CLOSE_MS) - now());

        throw error;
    }

    const served = async (): Promise<{ text: string; url: string } | null> => {
        try {
            const { frameTree } = await session.send("Page.getFrameTree");
            const answer = answers.get(frameTree.frame.loaderId);

            if (
                !answer ||
                frameTree.frame.loaderId !== loaderId ||
                strayed.has(loaderId) ||
                answer.response.fromServiceWorker ||
                answer.response.mimeType !== "text/html"
            ) {
                return null;
            }

            const { base64Encoded, body } = await session.send("Network.getResponseBody", { requestId: answer.requestId });

            return base64Encoded || body.length > MAX_SERVED_BYTES ? null : { text: body, url: answer.response.url };
        } catch {
            return null;
        }
    };

    return { detach, served };
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
 * Takes the password out of the page before `deadline`, with the guard and the channel lock still holding and the tab's
 * scripts off: leaves the document that had it for `about:blank` (its `pagehide` and `unload` handlers run under them,
 * and the workers it started go with it), loads the address again by GET when the hold leaves time for it, never
 * resending the form, and looks (`isClean`) before any script of it runs. Only a clean page has the lock lifted
 * (`release`, which must end within a second), and is then loaded once more with its scripts, time allowing. An address
 * that carries the password is not loaded again: the page stays blank, which is clean. Whether the page is verifiably
 * clean in time: when it is not, it must not be used again.
 */
const clearPassword = async (
    page: Page,
    {
        deadline,
        guard,
        navTimeout,
        now,
        password,
        release,
    }: { deadline: number; guard: Guard; navTimeout: number; now: () => number; password: string; release: () => Promise<void> },
): Promise<boolean> => {
    const address = page.url();
    // The end of the time the reload and the look may take: the release has the last second.
    const lookUntil = deadline - CLOSE_MS;

    try {
        // The command can stall: the hold ends regardless, and the page is closed.
        if (now() >= lookUntil || !(await within(guard.shield(), lookUntil - now(), false))) {
            return false;
        }

        await page.goto("about:blank", { timeout: lookUntil - now() });
    } catch {
        return false;
    }

    const reloadMs = lookUntil - CHECK_MS - now();
    const isReloaded = reloadMs >= 1000 && originOf(address) !== null && !hasSecret(address, password);

    if (isReloaded) {
        guard.admit(address);

        try {
            await page.goto(address, { timeout: Math.min(navTimeout, reloadMs), waitUntil: "domcontentloaded" });
        } catch {
            return false;
        }

        if (
            !(await within(
                isClean(page, password).catch(() => false),
                lookUntil - now(),
                false,
            ))
        ) {
            return false;
        }
    }

    // A lock still letting go would hold the next page's workers and WebRTC: the session is not handed back like that.
    if (
        !(await within(
            release()
                .then(() => true)
                .catch(() => false),
            CLOSE_MS,
            false,
        ))
    ) {
        return false;
    }

    // The page as the session goes on with it, scripts and all: it was clean without them.
    if (isReloaded && deadline - now() >= 1000) {
        await page.reload({ timeout: deadline - now(), waitUntil: "domcontentloaded" }).catch(() => undefined);
    }

    return true;
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
    let isLocking = false;
    let isStalled = false;
    let isLoadHeld = false;

    /** A step of the lock's setup, ended by the hold: one that does not settle in time has the tab closed with the session. */
    const settle = async <T>(start: () => Promise<T>, why = "The browser could not be locked for the sign-in in time, so nothing was typed"): Promise<T> => {
        // The time first: a step started and then given no time would run on unheld.
        const ms = left(pageTimeout);
        const settled = await within(
            start().then((value) => {
                return { value };
            }),
            ms,
            null,
        );

        if (!settled) {
            isStalled = true;

            throw new Error(why);
        }

        return settled.value;
    };

    /** A read of the page before the password is typed, ended by the hold: a page that does not answer has nothing typed. */
    const answered = async <T>(start: () => Promise<T>): Promise<T> => {
        const ms = left(pageTimeout);
        const settled = await within(
            start().then((value) => {
                return { value };
            }),
            ms,
            null,
        );

        if (!settled) {
            throw new Error("The login page did not answer in time, so the password was not typed");
        }

        return settled.value;
    };

    const failed = (error: string): Extract<SignInResult, { success: false }> => {
        const refused = guard ? null : lock?.refused();
        const why = refused ? `${error} (the page tried to start ${refused}, which is off while a saved login signs in, so it may not have loaded)` : error;

        return { error: scrub(why), submitted: Boolean(guard?.submitted()), success: false, url: scrub(page.url()) };
    };

    /** Opens the page and finds the fields; the password field, or why nothing will be typed. */
    const findFields = async () => {
        const load = await loadServed(page, { now, origin, timeout: left(navTimeout), url });

        try {
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

            const form = await answered(async () => field.evaluate(checkForm, { isAscii, origin }));

            if (form === "no-form") {
                return "The password field is not in a form, so nothing was typed or sent";
            }

            if (form === "off-site") {
                return `The login form would not send the password to ${origin} by POST in this window, so nothing was typed`;
            }

            // `re-encoded` only at the send, which compares the form with the one the site served.
            if (form === "encoding" || form === "re-encoded") {
                return "The login form encodes what it sends in a way the agent's browser cannot put a saved password into, so nothing was typed";
            }

            if (form.name === "") {
                return "The password field has no name, so its form would not send it; nothing was typed";
            }

            const html = await within(load.served(), left(SEND_WAIT_MS), null);
            const served = html ? servedForms(html.text, html.url) : [];
            const target = servedTarget(served, form);

            if (served.includes(AMBIGUOUS)) {
                return "A form of the login page has submit buttons that send it to different places, so the agent's browser cannot check where the password goes; nothing was typed";
            }

            if (html === null || served[0] === null) {
                return "The agent's browser cannot check where the login form sends the password (the page as the site sent it could not be read, or its first password field is in no form it can read), so nothing was typed";
            }

            if (!target) {
                return served.length > 0
                    ? "A script changed where the login form sends the password, so nothing was typed"
                    : "The login form is built by a script, so the agent's browser cannot check where it sends the password; nothing was typed";
            }

            // The form's controls in document order, those outside it by a `form` attribute included.
            const userHandle = await answered(async () =>
                field.evaluateHandle((input) => {
                    const { form: owner } = input as HTMLInputElement;
                    // Read by the prototype's getter: a control named `elements` hides the form's own.
                    const controls = owner
                        ? (Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, "elements")?.get?.call(owner) as HTMLFormControlsCollection)
                        : [];
                    const before = [...controls].filter(
                        (candidate): candidate is HTMLInputElement =>
                            candidate instanceof HTMLInputElement &&
                            ["", "email", "tel", "text"].includes(candidate.getAttribute("type")?.toLowerCase() ?? "") &&
                            candidate.getClientRects().length > 0 &&
                            Boolean(candidate.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING),
                    );

                    return before.at(-1) ?? null;
                }),
            );

            return { field, target, user: userHandle.asElement() };
        } finally {
            // Within the steps' time: a DevTools session that does not let go of the load fails the sign-in closed.
            isLoadHeld = !(await load.detach(Math.min(CLOSE_MS, deadline - CLEANUP_MS - now())));
        }
    };

    const attempt = async (): Promise<SignInResult> => {
        // A password field drops line breaks: the browser would never send one.
        if (LINE_BREAK_RE.test(password)) {
            return failed("The saved password has a line break, which a password field cannot hold, so nothing was typed");
        }

        // The username is typed before the guard holds, where the page reads it.
        if (username.toLowerCase().includes(password.toLowerCase())) {
            return failed("The saved username holds the saved password, which the page could read from the username field, so nothing was typed");
        }

        // Before the page loads: each socket it opens is then one the guard can close, and no worker, window or WebRTC
        // connection of it runs past the lock.
        await settle(async () => gateSockets(page.context()));

        // Its script is in the tab's document from the first command: one that fails part way leaves it there.
        isLocking = true;

        const locked = await settle(async () => lockChannels(page));

        lock = locked;

        const found = await findFields();

        if (typeof found === "string") {
            return failed(found);
        }

        if (deadline - now() < TYPE_RESERVE_MS) {
            return failed("Too little time was left to sign in, so nothing was typed. Try it again.");
        }

        if (isLoadHeld) {
            return failed("The browser did not let go of the login page in time, so nothing was typed");
        }

        const { field, target, user } = found;

        if (user) {
            await user.fill(username, { timeout: left(pageTimeout) });
        }

        const moved = offSite();

        if (moved) {
            return failed(`${moved}, so the password was not typed`);
        }

        if (!(await answered(async () => field.evaluate((input) => input.isConnected && (input as HTMLInputElement).type === "password")))) {
            return failed("The password field changed before it was typed into, so it was left empty");
        }

        // The browser sends a rule set's loads itself: one the page lock could not take out would carry what the page
        // puts in a link.
        if (await answered(async () => locked.speculates())) {
            return failed("The login page holds speculation rules that cannot be taken out, so the password was not typed");
        }

        // The page gets a stand-in, never the password: the guard puts the password into the form's own POST as it
        // leaves, so no script of the page (nor a request it makes the browser send) can read it.
        const maxLength = await answered(async () => field.evaluate((input) => (input as HTMLInputElement).maxLength));
        const longest = maxLength > 0 ? Math.max(maxLength, password.length) : Infinity;
        const stand = standIn(Math.min(Math.max(password.length, STAND_IN_LENGTH), longest), password);

        // A guard that is armed only after its time is taken down as it arrives; the tab goes with the session meanwhile.
        let isGuardLate = false;

        guard = await settle(async () => {
            const arming = armGuard(page, { form: target, lock: locked, origin, password, stand });

            arming.then(async (late) => (isGuardLate ? late.disarm() : undefined)).catch(() => undefined);

            return arming;
        }, "The browser could not be locked down for the send in time, so the password was not typed").catch((error: unknown) => {
            isGuardLate = true;

            throw error;
        });
        // One call sets the whole value: no keystroke can land after the hold.
        await field.fill(stand, { timeout: left(pageTimeout) });
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
            field.evaluate(checkForm, { expected: { charset: target.charset, enctype: target.enctype }, isAscii, origin }),
            left(pageTimeout),
            "busy",
        );

        if (form === "busy") {
            return failed("The page did not finish sending the form in time");
        }

        if (form === "re-encoded") {
            // Before the POST's scripts-off command answers: a navigation the page's `stop` did not end is not handed on.
            guard.giveUp();

            return failed("The login form changed how it encodes what it sends from the form the site served, so the password was not sent");
        }

        if (typeof form === "string") {
            return failed(`The login form changed to send the password elsewhere than ${origin} by POST, so it was not sent`);
        }

        const waitUntil = now() + left(SEND_WAIT_MS);

        while (
            !guard.submitted() &&
            !guard.attempt() &&
            !guard.changed() &&
            !guard.scripted() &&
            !guard.unshielded() &&
            !guard.unsent() &&
            !guard.oversized() &&
            !guard.reencoded() &&
            now() < waitUntil
        ) {
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

        if (guard.submitted() && guard.answerStatus() >= 400) {
            return failed(`The site answered the sign-in with an error (HTTP ${guard.answerStatus()}); the form was sent`);
        }

        if (guard.submitted()) {
            return { passwordFieldRemains: false, submitted: true, success: true, title: "", url: "" };
        }

        if (guard.scripted()) {
            return { ...failed("This site signs in with a script the agent's browser cannot fill safely, so the password was not sent"), scriptSignIn: true };
        }

        if (guard.unshielded()) {
            return failed("The browser could not be locked down for the send, so nothing was sent");
        }

        if (guard.oversized()) {
            return failed(
                `The login form sends more than the agent's browser checks for the password (${MAX_GUARDED_BODY_BYTES / 1024 / 1024} MiB), so it was not sent`,
            );
        }

        if (guard.reencoded()) {
            return failed("The login form changed how it encodes what it sends from the form the site served, so the password was not sent");
        }

        if (guard.unsent()) {
            return failed("The browser did not send the login form, so the password was not sent");
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
        // A setup that may still finish would lock or route the session's later pages.
        if (isStalled && !result.success) {
            await within(
                page.close().catch(() => undefined),
                1000,
                undefined,
            );

            return { ...result, sessionClosed: true };
        }

        if (isLocking && !result.success) {
            // A lock still letting go would hold the next page's workers and WebRTC: the session is not handed back like that.
            const isReleased = await within(
                (lock?.release() ?? Promise.resolve()).then(() => true).catch(() => false),
                CLOSE_MS,
                false,
            );
            // The document loaded under the lock keeps its locked APIs: the session goes on from a blank page, or none.
            const isBlank =
                isReleased &&
                (await within(
                    page
                        .goto("about:blank", { timeout: 1000 })
                        .then(() => true)
                        .catch(() => false),
                    1000,
                    false,
                ));

            if (!isBlank) {
                await within(
                    page.close().catch(() => undefined),
                    1000,
                    undefined,
                );

                return { ...result, sessionClosed: true };
            }
        }

        return result;
    }

    const armed = guard;

    // The result is settled: a send still on its way must not go out under it.
    armed.giveUp();
    // Both, even when one of them hangs or fails. It throws when the tab's scripts are not confirmed back on: such a page
    // is closed rather than handed on.
    const release = async (): Promise<void> => {
        const [scripts] = await Promise.allSettled([armed.disarm(), lock?.release()]);

        if (scripts.status !== "fulfilled" || !scripts.value) {
            throw new Error("The tab's scripts could not be turned back on");
        }
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
    if (!(await clearPassword(page, { deadline, guard: armed, navTimeout, now, password, release }))) {
        // Closed before the lock lifts: a worker it holds would run once let go.
        await within(
            page
                .close()
                .catch(() => undefined)
                .then(release)
                .catch(() => undefined),
            CLOSE_MS,
            undefined,
        );

        return {
            error: "The password could not be cleared from the page in time",
            sessionClosed: true,
            submitted: guard.submitted(),
            success: false,
        };
    }

    if (!result.success) {
        // A send handed on while the result was being settled counts.
        return { ...result, submitted: armed.submitted() };
    }

    return { ...result, passwordFieldRemains, title: scrub(title), url: landedAt };
};
