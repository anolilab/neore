/**
 * The saved-login fill: signs the agent's cloud browser in to a site with a login its owner saved
 * (`vault/site-logins.ts`). The password is decrypted here and handed to the renderer, which opens the login page and
 * types into it in one call (`services/browser-renderer` `/login`); it never reaches the model, a log line, the action
 * history or the session row. Everything this action returns is built from named fields and scrubbed of it.
 *
 * Which turn may sign in is decided by `siteLoginForFill` (through `siteLoginTurnVerdict`), never here. The model names
 * the site only, to find the login; the page opened is the one saved with it (or its front page), and the renderer
 * types only while the page is on the login's origin.
 */
import { browserLogin, type BrowserLoginResponse, createBrowserRendererClient } from "@neore/service-sdk/browser-renderer";
import { v } from "lunorash/server";

import type { Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/internal";
import { internalAction } from "../../_generated/server";
import { NO_PROVIDER_SESSION, rendererCallBudget, rendererCallHold } from "../../browser/live-view-logic";
import { decryptKey } from "../../lib/encryption";
import { toolsLogger } from "../../lib/logger";
import { isServiceBound, serviceFetch } from "../../lib/services";
import { normalizeSiteOrigin } from "../../vault/lib/site-origin";
import { siteLoginTurnFields } from "../../vault/site-logins";
import {
    BROWSER_CLOSED_BEFORE_ACTION,
    BROWSER_CLOSED_DURING_ACTION,
    BROWSER_RENDERER_CONNECT,
    type BrowserReturn,
    browserReplacedResult,
    handedBackResult,
    PERSON_HAS_CONTROL,
    sanitizeBrowserError,
} from "./browser-node";
import { validateDomain } from "./utilities";

/** What the model hears back. Never the username or the password. */
export interface SiteLoginFillResult {
    error?: string;
    /** A password field is still on the page after the form was sent: the sign-in may have failed. */
    passwordFieldRemains?: boolean;
    /** The site the login was saved for, once one was found. */
    site?: string;
    submitted?: boolean;
    success: boolean;
    title?: string;
    url?: string;
}

/** No login the turn may use is saved for the page's site. The same words whatever the reason, so none is told apart. */
export const NO_USABLE_LOGIN =
    "No saved login can be used for this site here. Logins are used only in the person's own chat, in a turn they typed themselves, for the exact site they were saved for. Ask the person to sign in themselves in the live view, or to save a login for this site.";

/** What a field read back says in its place when an escaped spelling of the login is in it: withheld whole. */
export const WITHHELD_FIELD = "[withheld: it holds the saved login]";

/** The JS escapes a page may spell a character with in a title, an address or an error: `\u0070`, `\u{70}`, `\x70`. */
const JS_ESCAPE_RE = /\\u\{([\da-f]{1,6})\}|\\u([\da-f]{4})|\\x([\da-f]{2})/gi;

/** The numeric HTML entities a page may spell a character with: `&#x70;`, `&#112;`. */
const ENTITY_RE = /&#(?:x([\da-f]{1,6})|(\d{1,7}));?/gi;

/** The character `code` names, or `escape` itself when it names none. */
const characterOf = (code: number, escape: string): string => (Number.isSafeInteger(code) && code <= 0x10_ff_ff ? String.fromCodePoint(code) : escape);

/** `text` with each JS escape and numeric HTML entity read as its character. */
const unescaped = (text: string): string =>
    text
        .replaceAll(JS_ESCAPE_RE, (escape, braced?: string, four?: string, byte?: string) =>
            characterOf(Number.parseInt(braced ?? four ?? byte ?? "", 16), escape),
        )
        .replaceAll(ENTITY_RE, (escape, hex?: string, decimal?: string) =>
            characterOf(hex === undefined ? Number.parseInt(decimal ?? "", 10) : Number.parseInt(hex, 16), escape),
        );

/** The spellings an address, a form body or a page gives `secret`: raw, URI- (either case) and form-encoded. */
const spellingsOf = (secret: string): string[] => {
    const uri = encodeURIComponent(secret);

    return [
        ...new Set([new URLSearchParams({ p: secret }).toString().slice(2), secret, uri, uri.replaceAll(/%[\dA-F]{2}/g, (escape) => escape.toLowerCase())]),
    ];
};

/** The shortest username scrubbed: a shorter one would blank ordinary words, and tells nothing of the account. */
const MIN_SCRUBBED_USERNAME = 3;

/**
 * `text` with the password and the username, in the forms an address or a form body encodes them in, replaced; withheld
 * whole when an escaped spelling of either is in it, which no replacement could find.
 */
export const withoutLogin = (text: string | undefined, { password, username }: { password?: string; username: string }): string | undefined => {
    if (text === undefined) {
        return undefined;
    }

    const secrets = [
        ...(password === undefined ? [] : [{ marker: "[password]", value: password }]),
        ...(username.length >= MIN_SCRUBBED_USERNAME ? [{ marker: "[username]", value: username }] : []),
    ];
    const read = unescaped(text);

    if (read !== text && secrets.some(({ value }) => spellingsOf(value).some((spelling) => read.includes(spelling)))) {
        return WITHHELD_FIELD;
    }

    let scrubbed = text;

    for (const { marker, value } of secrets) {
        for (const spelling of spellingsOf(value)) {
            scrubbed = scrubbed.replaceAll(spelling, () => marker);
        }
    }

    return scrubbed;
};

/** `text` with the password, and the forms an address or a form body encodes it in, replaced. */
export const withoutPassword = (text: string | undefined, password: string): string | undefined => withoutLogin(text, { password, username: "" });

/** The saved password is too short for the renderer to keep out of what it returns (`/login` refuses it too). */
export const MIN_FILL_PASSWORD_LENGTH = 4;

/** The least time a `/login` call takes (the renderer's own floor): with less left, nothing is sent. */
const MIN_LOGIN_BUDGET_MS = 20_000;

/** The site signs in from a script that reads the field, which only ever holds a stand-in: a refusal, not a wrong password. */
export const SCRIPT_SIGN_IN =
    "This site signs in with a script that reads the password field, so a saved login cannot be typed into it safely and nothing was sent. Trying again will not help: ask the person to sign in themselves in the live view.";

/** The saved password is shorter than the renderer can keep out of its results. */
export const PASSWORD_TOO_SHORT =
    "The password saved for this site is too short to be typed without it showing in what the browser returns, so nothing was typed. Ask the person to sign in themselves in the live view.";

/** The saved password could not be decrypted: nothing was typed. */
export const PASSWORD_UNREADABLE =
    "The password saved for this site could not be read, so nothing was typed. Ask the person to save the login again, or to sign in themselves in the live view.";

/** The browser session the renderer retired was replaced, but too little time was left to sign in on the new one. */
export const SIGN_IN_RETIRED =
    "The browser session was retired and cannot be used again, so nothing was typed. Ask to sign in again: the next sign-in opens a new browser.";

/** The page whose close the renderer could not confirm: it may still be open, and the thread will not use it again. */
const CLOSE_UNCONFIRMED_NOTE = "The browser session could not be confirmed closed, so it will not be used again; the next browser action opens a new one.";

const refused = (error: string, site?: string): SiteLoginFillResult => {
    return { error, success: false, ...(site !== undefined && { site }) };
};

export const fillSavedLogin = internalAction
    .input({
        /** The site to sign in to, as the model names it: only its origin is read, to find the login. */
        site: v.string().max(2048),
        threadId: v.id("threads"),
        turn: v.object({ ...siteLoginTurnFields }),
        userId: v.string(),
        userTier: v.optional(v.string()),
    })
    .action(async ({ args, ctx }): Promise<SiteLoginFillResult> => {
        const { threadId, turn, userId } = args;

        if (!isServiceBound(ctx, "browserRenderer")) {
            return refused("Browser automation is not configured: the browser-renderer service binding (SERVICE_BROWSER_RENDERER) is not bound.");
        }

        const named = URL.canParse(args.site) ? new URL(args.site) : null;
        const site = named?.protocol === "https:" ? normalizeSiteOrigin(named.href) : null;

        if (site === null) {
            return refused("The site must be a full https:// address.");
        }

        const login = await ctx.runQuery(internal.vault.site_logins.siteLoginForFill, { site, threadId, turn, userId });

        if (!login) {
            ctx.log.event("vault.site_login_fill", { outcome: "no-login" });

            return refused(NO_USABLE_LOGIN, site);
        }

        // The page saved with the login, or its site's front page: never one the model names. The renderer only proves
        // that the site sent the form it types into, not that it is a sign-in form.
        const page = login.signInUrl ?? `${login.site}/`;

        // The owner's allowed and blocked domains, as for any page the agent opens.
        const blocked = validateDomain(page, await ctx.runQuery(internal.browser.functions.getBrowserDomainSettings, { userId }));

        if (blocked) {
            return refused(blocked, login.site);
        }

        const startTime = Date.now();
        const rateKey = `browser/action:${args.userTier ?? "free"}`;
        let held: { reaped?: boolean; sessionId: Id<"browserSessions">; until: number } | undefined;
        let returned: BrowserReturn | undefined;
        let callEndsBy: number | undefined;
        // Set once decrypted; every string read back passes through it, the username scrubbed from the start.
        let password: string | undefined;
        const scrub = (text: string | undefined): string | undefined => withoutLogin(text, { password, username: login.username });
        const told = (result: SiteLoginFillResult): SiteLoginFillResult => (returned === undefined ? result : handedBackResult(result, returned));

        /** Nothing was typed: the hold ends and the charge is given back. */
        const unrun = async (error: string): Promise<SiteLoginFillResult> => {
            if (held !== undefined) {
                const ended = held;

                held = undefined;
                await ctx.runMutation(internal.browser.functions.endSessionUse, ended).catch(() => undefined);
            }

            await ctx.runMutation(internal.lib.rate_limiter_mutations.refundRateLimit, { identifier: userId, key: rateKey }).catch(() => undefined);

            return told(refused(error, login.site));
        };

        try {
            // As every browser action: the thread's session, held for the whole renderer call, refused while a person drives.
            let session = await ctx.runQuery(internal.browser.functions.getActiveSession, { threadId });

            if (!session) {
                await ctx.runMutation(internal.browser.functions.createSession, { connectUrl: BROWSER_RENDERER_CONNECT, threadId, userId });
                session = await ctx.runQuery(internal.browser.functions.getActiveSession, { threadId });
            }

            if (!session) {
                throw new Error("The browser session could not be opened. Try it again.");
            }

            const startedWithProviderSessionId = session.providerSessionId ?? null;
            // The row's browser when the result is logged: none, once a retired one is dropped.
            let startedWith = startedWithProviderSessionId;
            const cfSessionId = session.providerSessionId === NO_PROVIDER_SESSION ? undefined : session.providerSessionId;
            const until = rendererCallHold(Date.now());
            const use = await ctx.runMutation(internal.browser.functions.beginSessionUse, { sessionId: session._id, until });

            if (use.controlled) {
                return refused(PERSON_HAS_CONTROL, login.site);
            }

            if (!use.held) {
                return refused(BROWSER_CLOSED_BEFORE_ACTION, login.site);
            }

            held = { sessionId: session._id, until, ...(use.reaped === true && { reaped: true }) };
            returned = use.returned;
            // After a hand back the sign-in opens a fresh page, so it does not look first; its result is the look.
            const { inspecting } = use;

            const rlResult = await ctx.runMutation(internal.lib.rate_limiter_mutations.applyRateLimit, { identifier: userId, key: rateKey });

            if (!rlResult.ok) {
                const ended = held;

                held = undefined;
                await ctx.runMutation(internal.browser.functions.endSessionUse, ended);

                return told(refused("Browser automation rate limit exceeded.", login.site));
            }

            try {
                password = await decryptKey(login.encryptedPassword, "site-logins");
            } catch {
                // Nothing was sent: the hold ends and the charge is given back, as for any sign-in that typed nothing.
                return await unrun(PASSWORD_UNREADABLE);
            }

            if (password.length < MIN_FILL_PASSWORD_LENGTH) {
                return await unrun(PASSWORD_TOO_SHORT);
            }

            const client = createBrowserRendererClient({ fetch: serviceFetch(ctx, "browserRenderer") });
            /** One `/login` call on `sessionId` (none: a new browser), within what is left of the hold. */
            const signInOn = async (sessionId: string | undefined) => {
                const budget = rendererCallBudget(held?.until ?? 0, Date.now());

                if (budget < MIN_LOGIN_BUDGET_MS) {
                    return null;
                }

                const callSignal = AbortSignal.timeout(budget);

                callEndsBy = Date.now() + budget;

                // The page opens and is typed into in this one call: nothing it shows can reach the model in between.
                return await browserLogin({
                    // The renderer fits every step into the budget, so it types nothing after the hold could have ended.
                    body: { budgetMs: budget, origin: login.site, password: password ?? "", sessionId, url: page, username: login.username },
                    client,
                    signal: callSignal,
                });
            };

            let call = await signInOn(cfSessionId);

            if (call === null) {
                return await unrun("The sign-in started too late and was not sent. Try it again.");
            }

            // The renderer retired the thread's browser for good (an earlier sign-in on it could not confirm its page clean):
            // the row forgets it first, then the sign-in runs once on a new browser.
            if (call.response?.status === 410 && cfSessionId !== undefined) {
                const dropped = await ctx.runMutation(internal.browser.functions.logAction, {
                    action: "login",
                    durationMs: Date.now() - startTime,
                    errorMessage: SIGN_IN_RETIRED,
                    providerSessionId: NO_PROVIDER_SESSION,
                    sessionId: session._id,
                    startedAt: startTime,
                    startedWithProviderSessionId,
                    success: false,
                    target: login.site,
                });

                if (dropped.closed === true || dropped.replaced) {
                    return await unrun(dropped.closed === true ? BROWSER_CLOSED_DURING_ACTION : browserReplacedResult(dropped.currentUrl).error);
                }

                startedWith = NO_PROVIDER_SESSION;
                call = await signInOn(undefined);

                if (call === null) {
                    return await unrun(SIGN_IN_RETIRED);
                }
            }

            const { data: answered, error: failure, response } = call;
            // A refusal comes back with the same shape as an answer; its words are read like one.
            const data = (answered ?? failure) as (BrowserLoginResponse & { code?: string }) | undefined;

            if (!data) {
                // No answer to read: whether the page was cleared or closed is unknown, so the row keeps no browser of it.
                await ctx.runMutation(internal.browser.functions.logAction, {
                    action: "login",
                    durationMs: Date.now() - startTime,
                    errorMessage: "The renderer's answer could not be read",
                    providerSessionId: NO_PROVIDER_SESSION,
                    sessionId: session._id,
                    startedAt: startTime,
                    startedWithProviderSessionId: startedWith,
                    success: false,
                    target: login.site,
                });

                throw new Error(`Browser renderer returned ${response?.status ?? "no response"}`);
            }

            // Refused before anything was typed: another call holds the session (409), its lock did not answer or the sign-in
            // could not be armed (503), or the session was retired on the new browser too (410). A session it says is gone
            // (retired, or a reconnect that failed) is dropped from the row first.
            if (response?.status === 409 || response?.status === 410 || response?.status === 503) {
                if (response.status === 410 || data.sessionClosed === true) {
                    await ctx.runMutation(internal.browser.functions.logAction, {
                        action: "login",
                        durationMs: Date.now() - startTime,
                        errorMessage: scrub(data.error),
                        providerSessionId: NO_PROVIDER_SESSION,
                        sessionId: session._id,
                        startedAt: startTime,
                        startedWithProviderSessionId: startedWith,
                        success: false,
                        target: login.site,
                    });
                }

                return await unrun(response.status === 410 ? SIGN_IN_RETIRED : (scrub(data.error) ?? "The sign-in could not run. Try it again in a moment."));
            }

            let error = scrub(data.error);

            if (data.scriptSignIn === true) {
                error = SCRIPT_SIGN_IN;
            } else if (data.sessionCloseUnconfirmed === true) {
                error = `${error ?? "The sign-in did not finish."} ${CLOSE_UNCONFIRMED_NOTE}`;
            }

            const result: SiteLoginFillResult = {
                ...(error !== undefined && { error }),
                ...(data.passwordFieldRemains !== undefined && { passwordFieldRemains: data.passwordFieldRemains }),
                site: login.site,
                ...(data.submitted !== undefined && { submitted: data.submitted }),
                success: data.success === true,
                ...(data.title !== undefined && { title: scrub(data.title) }),
                ...(data.url !== undefined && { url: scrub(data.url) }),
            };

            // The site only: never the username or password, nor the page's error in their words. A session the renderer
            // closed, or could not confirm closed, comes back with no id: the row keeps no browser to reuse.
            const logged = await ctx.runMutation(internal.browser.functions.logAction, {
                action: "login",
                currentUrl: result.url,
                durationMs: Date.now() - startTime,
                errorMessage: result.error,
                heldReaped: held.reaped,
                heldUntil: held.until,
                ...(inspecting !== undefined && result.success && { inspected: inspecting }),
                providerSessionId: data.sessionId ?? NO_PROVIDER_SESSION,
                sessionId: session._id,
                startedAt: startTime,
                startedWithProviderSessionId: startedWith,
                success: result.success,
                target: login.site,
            });

            ctx.log.event("vault.site_login_fill", { outcome: result.success ? "submitted" : "failed" });

            if (logged.closed === true || logged.replaced) {
                return told(
                    logged.closed === true
                        ? refused(BROWSER_CLOSED_DURING_ACTION, login.site)
                        : { ...browserReplacedResult(logged.currentUrl), site: login.site },
                );
            }

            return told(result);
        } catch (error) {
            // Once a `/login` call went out, a failure says nothing of whether the renderer still types: its hold runs out
            // on its own, so no person takes control mid-fill. Only one never sent lets go of it at once.
            const mayStillAct = callEndsBy !== undefined;

            if (held !== undefined && !mayStillAct) {
                await ctx.runMutation(internal.browser.functions.endSessionUse, held).catch(() => undefined);
            }

            const message = scrub(sanitizeBrowserError(error));

            toolsLogger.warn(`[SITE_LOGIN] Sign-in failed: ${message}`);

            return told(refused(`The sign-in failed: ${message}`, login.site));
        }
    });
