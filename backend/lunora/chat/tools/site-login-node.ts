/**
 * The saved-login fill: signs the agent's cloud browser in to a site with a login its owner saved
 * (`vault/site-logins.ts`). The password is decrypted here and handed to the renderer, which opens the login page and
 * types into it in one call (`services/browser-renderer` `/login`); it never reaches the model, a log line, the action
 * history or the session row. Everything this action returns is built from named fields and scrubbed of it.
 *
 * Which turn may sign in is decided by `siteLoginForFill` (through `siteLoginTurnVerdict`), never here; the site is the
 * origin of the login page the call names, and the renderer types only while the page is on it.
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

/** `text` with the password, and the forms an address or a form body encodes it in, replaced. */
export const withoutPassword = (text: string | undefined, password: string): string | undefined => {
    if (text === undefined) {
        return undefined;
    }

    let scrubbed = text;

    for (const form of [password, encodeURIComponent(password), new URLSearchParams({ p: password }).toString().slice(2)]) {
        scrubbed = scrubbed.replaceAll(form, "[password]");
    }

    return scrubbed;
};

const refused = (error: string, site?: string): SiteLoginFillResult => {
    return { error, success: false, ...(site !== undefined && { site }) };
};

export const fillSavedLogin = internalAction
    .input({
        threadId: v.id("threads"),
        turn: v.object({ ...siteLoginTurnFields }),
        url: v.string().max(8192),
        userId: v.string(),
        userTier: v.optional(v.string()),
    })
    .action(async ({ args, ctx }): Promise<SiteLoginFillResult> => {
        const { threadId, turn, userId } = args;

        if (!isServiceBound(ctx, "browserRenderer")) {
            return refused("Browser automation is not configured: the browser-renderer service binding (SERVICE_BROWSER_RENDERER) is not bound.");
        }

        let page: URL;

        try {
            page = new URL(args.url);
        } catch {
            return refused("The login page must be a full https:// address.");
        }

        const site = page.protocol === "https:" ? normalizeSiteOrigin(page.href) : null;

        if (site === null) {
            return refused("The login page must be a full https:// address.");
        }

        // The owner's allowed and blocked domains, as for any page the agent opens.
        const blocked = validateDomain(page.href, await ctx.runQuery(internal.browser.functions.getBrowserDomainSettings, { userId }));

        if (blocked) {
            return refused(blocked, site);
        }

        const login = await ctx.runQuery(internal.vault.site_logins.siteLoginForFill, { site, threadId, turn, userId });

        if (!login) {
            ctx.log.event("vault.site_login_fill", { outcome: "no-login" });

            return refused(NO_USABLE_LOGIN, site);
        }

        const startTime = Date.now();
        let held: { reaped?: boolean; sessionId: Id<"browserSessions">; until: number } | undefined;
        let returned: BrowserReturn | undefined;
        let callSignal: AbortSignal | undefined;
        let callEndsBy: number | undefined;
        // Set once decrypted; every string read back passes through it.
        let password: string | undefined;
        const scrub = (text: string | undefined): string | undefined => (password === undefined ? text : withoutPassword(text, password));

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
            const cfSessionId = session.providerSessionId === NO_PROVIDER_SESSION ? undefined : session.providerSessionId;
            const until = rendererCallHold(Date.now());
            const use = await ctx.runMutation(internal.browser.functions.beginSessionUse, { sessionId: session._id, until });

            if (use.controlled) {
                return refused(PERSON_HAS_CONTROL, site);
            }

            if (!use.held) {
                return refused(BROWSER_CLOSED_BEFORE_ACTION, site);
            }

            held = { sessionId: session._id, until, ...(use.reaped === true && { reaped: true }) };
            returned = use.returned;
            // After a hand back the sign-in opens a fresh page, so it does not look first; its result is the look.
            const { inspecting } = use;

            const rlResult = await ctx.runMutation(internal.lib.rate_limiter_mutations.applyRateLimit, {
                identifier: userId,
                key: `browser/action:${args.userTier ?? "free"}`,
            });

            if (!rlResult.ok) {
                await ctx.runMutation(internal.browser.functions.endSessionUse, held);

                return refused("Browser automation rate limit exceeded.", site);
            }

            const budget = rendererCallBudget(held.until, Date.now());

            if (budget === 0) {
                throw new Error("The sign-in started too late and was not sent. Try it again.");
            }

            password = await decryptKey(login.encryptedPassword, "site-logins");
            callSignal = AbortSignal.timeout(budget);
            callEndsBy = Date.now() + budget;

            // The page opens and is typed into in this one call: nothing it shows can reach the model in between.
            const {
                data: answered,
                error: failure,
                response,
            } = await browserLogin({
                // The renderer fits every step into the budget, so it types nothing after the hold could have ended.
                body: { budgetMs: budget, origin: login.site, password, sessionId: cfSessionId, url: page.href, username: login.username },
                client: createBrowserRendererClient({ fetch: serviceFetch(ctx, "browserRenderer") }),
                signal: callSignal,
            });

            // A refusal comes back as a 400 or 500 with the same shape; its words are read like an answer's.
            const data = (answered ?? failure) as BrowserLoginResponse | undefined;

            if (!data) {
                throw new Error(`Browser renderer returned ${response?.status ?? "no response"}`);
            }

            const result: SiteLoginFillResult = {
                ...(data.error !== undefined && { error: scrub(data.error) }),
                ...(data.passwordFieldRemains !== undefined && { passwordFieldRemains: data.passwordFieldRemains }),
                site: login.site,
                ...(data.submitted !== undefined && { submitted: data.submitted }),
                success: data.success === true,
                ...(data.title !== undefined && { title: scrub(data.title) }),
                ...(data.url !== undefined && { url: scrub(data.url) }),
            };

            // The site only: never the username or password, nor the page's error in their words.
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
                startedWithProviderSessionId,
                success: result.success,
                target: login.site,
            });

            ctx.log.event("vault.site_login_fill", { outcome: result.success ? "submitted" : "failed" });

            if (logged.closed === true || logged.replaced) {
                const discarded = logged.closed === true ? refused(BROWSER_CLOSED_DURING_ACTION, site) : { ...browserReplacedResult(logged.currentUrl), site };

                return returned === undefined ? discarded : handedBackResult(discarded, returned);
            }

            return returned === undefined ? result : handedBackResult(result, returned);
        } catch (error) {
            const mayStillAct = callSignal?.aborted === true || (callEndsBy !== undefined && Date.now() >= callEndsBy);

            if (held !== undefined && !mayStillAct) {
                await ctx.runMutation(internal.browser.functions.endSessionUse, held).catch(() => undefined);
            }

            const message = scrub(sanitizeBrowserError(error));

            toolsLogger.warn(`[SITE_LOGIN] Sign-in failed: ${message}`);

            const failed = refused(`The sign-in failed: ${message}`, site);

            return returned === undefined ? failed : handedBackResult(failed, returned);
        }
    });
