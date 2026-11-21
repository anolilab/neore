/**
 * Browser Automation Node Action
 *
 * Internal action that drives a headless browser through the Cloudflare
 * Browser Rendering worker.
 * Each invocation either reuses an existing session (by thread) or creates a new one.
 *
 * Supports: navigate, screenshot, click, type, extract, scroll.
 */
import { browserAction, type BrowserActionResponse, createBrowserRendererClient } from "@neore/service-sdk/browser-renderer";
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/internal";
import { internalAction } from "../../_generated/server";
import { NO_PROVIDER_SESSION, rendererCallBudget, rendererCallHold } from "../../browser/live-view-logic";
import { isServiceBound, serviceFetch } from "../../lib/services";
import { validateDomain } from "./utilities";

("use node");

/** What a session row records as its `connectUrl`: the renderer has no URL any more, only a binding. */
const BROWSER_RENDERER_CONNECT = "service:browserRenderer";

export const executeBrowserAction = internalAction
    .input({
        action: v.union(v.literal("navigate"), v.literal("screenshot"), v.literal("click"), v.literal("type"), v.literal("extract"), v.literal("scroll")),
        browserSettings: v.optional(v.any()),
        direction: v.optional(v.string()),
        fullPage: v.optional(v.boolean()),
        selector: v.optional(v.string()),
        text: v.optional(v.string()),
        threadId: v.id("threads"),
        url: v.optional(v.string()),
        userId: v.string(),
        userTier: v.optional(v.string()),
    })
    .action(async ({ args, ctx }) => {
        const { action, browserSettings, threadId, userId } = args;

        // ── Cloudflare Browser Rendering path — the browser-renderer Worker,
        // over its service binding. Absent binding → the "not configured" error
        // below, instead of a failure inside the client.
        if (isServiceBound(ctx, "browserRenderer")) {
            // Domain validation for navigate actions
            if (action === "navigate" && args.url) {
                const domainError = validateDomain(args.url, browserSettings as any);

                if (domainError) {
                    return { error: domainError, success: false };
                }
            }

            const startTime = Date.now();
            // The session this action holds while it runs, and its hold's deadline; released if the action fails.
            let held: { reaped?: boolean; sessionId: Id<"browserSessions">; until: number } | undefined;
            // A person's hand back this action is the first to hear of; the note reaches the agent even if the action fails.
            let returned: BrowserReturn | undefined;
            // The renderer call's deadline, and when it falls: a call that ran until then may still be acting in the renderer.
            let callSignal: AbortSignal | undefined;
            let callEndsBy: number | undefined;

            try {
                // Check for existing CF session to enable multi-step workflows. The thread's first action opens the row
                // before its renderer call, not after: it holds that row like any other, so a second action that finishes
                // first cannot leave it free for a person to take while this one still opens its browser.
                let sessionDocument = await ctx.runQuery(internal.browser.functions.getActiveSession, { threadId });

                if (!sessionDocument) {
                    await ctx.runMutation(internal.browser.functions.createSession, { connectUrl: BROWSER_RENDERER_CONNECT, threadId, userId });
                    sessionDocument = await ctx.runQuery(internal.browser.functions.getActiveSession, { threadId });
                }

                if (!sessionDocument) {
                    throw new Error("The browser session could not be opened. Try it again.");
                }

                // What the row named when this action started: its result is written only if no other action moved it on.
                const startedWithProviderSessionId = sessionDocument.providerSessionId ?? null;
                const cfSessionId = sessionDocument.providerSessionId === NO_PROVIDER_SESSION ? undefined : sessionDocument.providerSessionId;
                const sessionId = sessionDocument._id;

                // The row is in use from here on, not only once the action returns: no person takes control mid-action, and
                // a slow action on a browser still alive does not read as idle (one read as reaped is held without being
                // offered: its old page must not come back while the renderer replaces it). The same write refuses the
                // action while a person drives the browser, and tells of a hand back once.
                // Past the end of the renderer call, however late it starts.
                const until = rendererCallHold(Date.now());
                const use = await ctx.runMutation(internal.browser.functions.beginSessionUse, { sessionId, until });

                if (use.controlled) {
                    return { error: PERSON_HAS_CONTROL, success: false };
                }

                // The session closed between the read above and the hold: its browser is not the thread's any more, so
                // nothing is sent to it. The next action opens a fresh one.
                if (!use.held) {
                    return { error: BROWSER_CLOSED_BEFORE_ACTION, success: false };
                }

                held = { sessionId, until, ...(use.reaped === true && { reaped: true }) };
                returned = use.returned;
                // The ended lease this action looks at the page for: once a look came back, the next actions act again.
                const { inspecting } = use;

                // Rate limiting: only an action that runs is counted, not one refused while a person drives the browser.
                const rlResult = await ctx.runMutation(internal.lib.rate_limiter_mutations.applyRateLimit, {
                    identifier: userId,
                    key: `browser/action:${args.userTier ?? "free"}`,
                });

                if (!rlResult.ok) {
                    await ctx.runMutation(internal.browser.functions.endSessionUse, held);

                    if (returned === undefined) {
                        return { error: "Browser automation rate limit exceeded.", success: false };
                    }

                    // The note stays on the row (only a look that came back clears it): the next action hears it again.
                    return {
                        error: `${handBackNote(returned)} Your ${action} action was not run: the browser automation rate limit was exceeded. Your next browser action shows you the page first.`,
                        success: false,
                    };
                }

                // After a hand back the page is not the one the agent planned against: it looks before it acts. A
                // navigate to a browser that was closed runs as asked: there is no page left to look at.
                const reopens = action === "navigate" && (returned === "browser_closed" || cfSessionId === undefined);
                const looksFirst = returned !== undefined && action !== "screenshot" && action !== "extract" && !reopens;

                const client = createBrowserRendererClient({ fetch: serviceFetch(ctx, "browserRenderer") });
                // A call that starts late is cut off before its hold ends, never after it; one too late for any of it is not sent.
                const budget = rendererCallBudget(held.until, Date.now());

                if (budget === 0) {
                    throw new Error("The action started too late and was not sent. Try it again.");
                }

                callSignal = AbortSignal.timeout(budget);
                callEndsBy = Date.now() + budget;

                const { data, error, response } = await browserAction({
                    body: looksFirst
                        ? { action: "screenshot", sessionId: cfSessionId }
                        : {
                              action,
                              direction: args.direction as "up" | "down" | undefined,
                              fullPage: args.fullPage,
                              selector: args.selector,
                              sessionId: cfSessionId,
                              text: args.text,
                              url: args.url,
                          },
                    client,
                    signal: callSignal,
                });

                if (error || !response?.ok || !data) {
                    throw new LunoraError("INTERNAL", `Browser renderer returned ${response?.status ?? "no response"}: ${JSON.stringify(error)}`);
                }

                const result = data as BrowserActionResponse;
                const durationMs = Date.now() - startTime;

                // Store the CF session ID so subsequent actions reuse the same browser. No id: the renderer kept no
                // browser (it closed it after a blocked redirect), so there is nothing to reuse or watch.
                const returnedSessionId = result.sessionId ?? NO_PROVIDER_SESSION;

                // One write: a replaced browser's id, the page this action left it on, the activity stamp, this action's hold's end.
                const logged = await ctx.runMutation(internal.browser.functions.logAction, {
                    action: looksFirst ? "screenshot" : action,
                    currentUrl: result.url,
                    durationMs,
                    errorMessage: result.error,
                    heldReaped: held.reaped,
                    heldUntil: held.until,
                    ...(inspecting !== undefined && result.success === true && { inspected: inspecting }),
                    providerSessionId: returnedSessionId,
                    sessionId,
                    startedAt: startTime,
                    startedWithProviderSessionId,
                    success: result.success ?? false,
                    target: looksFirst ? undefined : (args.url ?? args.selector),
                    value: looksFirst ? undefined : args.text,
                });

                // Another action at the same time left the thread on another browser: this result's page, content and
                // screenshot are of a browser the next step will not use, so none of it reaches the model.
                if (logged.closed === true || logged.replaced) {
                    const discarded =
                        logged.closed === true ? { error: BROWSER_CLOSED_DURING_ACTION, success: false } : browserReplacedResult(logged.currentUrl);

                    return returned === undefined ? discarded : handedBackResult(discarded, returned);
                }

                if (returned === undefined) {
                    return result;
                }

                return handedBackResult(result, returned, looksFirst ? action : undefined);
            } catch (error) {
                // Whether the browser survived is unknown: the row falls back to its last confirmed activity. A call cut off
                // at its deadline may still be acting in the renderer: its hold runs out on its own, so no person takes
                // control while it lands.
                // The signal, as the clock may lag the timer that fired it.
                const mayStillAct = callSignal?.aborted === true || (callEndsBy !== undefined && Date.now() >= callEndsBy);

                if (held !== undefined && !mayStillAct) {
                    await ctx.runMutation(internal.browser.functions.endSessionUse, held).catch(() => undefined);
                }

                const failed = { error: `CF Browser Rendering error: ${sanitizeBrowserError(error)}`, success: false };

                return returned === undefined ? failed : handedBackResult(failed, returned);
            }
        }

        // Browserbase is gone. The Cloudflare Browser Rendering path above is the
        // only one now — it already handled every action, and it already reuses a
        // session across calls (the `sessionId` round-trip), which is what makes
        // navigate -> click -> extract work as three separate tool calls.
        //
        // Dropping it removes a paid third-party dependency, its two API keys, and
        // the `playwright-core` + `@browserbasehq/sdk` imports (neither of which
        // resolved in this workspace).
        return {
            error: "Browser automation is not configured: the browser-renderer service binding (SERVICE_BROWSER_RENDERER) is not bound.",
            success: false,
        };
    });

type BrowserReturn = "browser_closed" | "handed_back" | "idle" | "left";

/** What the agent hears while a person drives the browser from the live view: it never acts beside their input. */
export const PERSON_HAS_CONTROL =
    "The person watching this chat has taken control of the browser and is using it now, so this action was not run. Do not use the browser until they hand it back: tell them what you are waiting for, or ask them, and try again later.";

/** The session was closed just before the action reached it: nothing was sent, and the next action starts a new browser. */
export const BROWSER_CLOSED_BEFORE_ACTION =
    "The browser session was closed just before this action, so it was not run. Run it again if it is still needed: the next action opens a new, empty browser, so navigate to the page you need first.";

/** The session was closed while the action ran: a later action starts from a new, empty browser. */
export const BROWSER_CLOSED_DURING_ACTION =
    "The browser session was closed while this action ran, so its result was discarded: it is not about the browser the next action will use. That browser starts empty: navigate to the page you need first.";

const RETURN_REASON: Record<BrowserReturn, string> = {
    browser_closed: "the browser they drove was closed or replaced (a page they opened was blocked, or the browser had expired), so control returned to you",
    handed_back: "handed it back",
    idle: "stopped using it, so control returned to you",
    left: "left the live view, so control returned to you",
};

/** Why the agent no longer drives the browser alone: a person had it, and gave it back. */
const handBackNote = (returned: BrowserReturn): string => `The person had control of the browser and ${RETURN_REASON[returned]}; the page may have changed.`;

/**
 * The first action after a person drove the browser: the result says so, and names the page the browser is on now. An
 * action that would change the page (`skipped`) was not run; a screenshot of the page came back in its place.
 * `handedBack` marks it for the human-check ladder (`browser/human-check.ts`), which tells whether a check it asked about cleared.
 */
const handedBackResult = <T extends { error?: string; success?: boolean; url?: string }>(
    result: T,
    returned: BrowserReturn,
    skipped?: string,
): T & { handedBack: true } => {
    const page = result.url === undefined ? "The current page is unknown." : `The browser is now on ${result.url}.`;
    const note = `${handBackNote(returned)} ${page} ${
        skipped === undefined
            ? "Look at this result again before you act."
            : `Your ${skipped} action was not run: this is a screenshot of the page instead. Look at it, then decide what to do.`
    }`;

    return {
        ...result,
        error: result.error === undefined ? note : `${note} ${result.error}`,
        handedBack: true,
        ...(skipped !== undefined && { success: false }),
    };
};

/** What the agent hears from an action whose browser another, concurrent action replaced: look again, on the kept browser. */
const browserReplacedResult = (keptUrl: string | undefined): { error: string; success: false; url?: string } => {
    return {
        error: `Another browser action ran at the same time and the thread now uses its browser, not the one this action ran on, so this action's result was discarded. ${
            keptUrl === undefined
                ? "The browser's current page is unknown, and it may have none: navigate to the page you need before the next step."
                : `The browser is on ${keptUrl}: take a screenshot or extract the page before the next step.`
        } Repeat this action there if it is still needed.`,
        success: false,
        ...(keptUrl !== undefined && { url: keptUrl }),
    };
};

const sanitizeBrowserError = (error: unknown): string => {
    const raw = error instanceof Error ? error.message : String(error);

    return (
        raw
            // wss://… or ws://… with anything after — strip everything past the host
            .replaceAll(/wss?:\/\/\S+/gi, "[redacted-cdp-url]")
            // Strip any URL with a query string — token-bearing
            .replaceAll(/https?:\/\/[^\s?]+\?\S+/gi, "[redacted-url-with-query]")
            // Hex-looking tokens >= 24 chars
            .replaceAll(/\b[a-f0-9]{24,}\b/gi, "[redacted-token]")
    );
};

export const closeBrowserSession = internalAction
    .input({
        sessionId: v.id("browserSessions"),
    })
    .action(async ({ args: { sessionId }, ctx }) => {
        // Mark as completed — the renderer worker reaps the remote browser itself
        await ctx.runMutation(internal.browser.functions.closeSession, {
            sessionId,
            status: "completed",
        });
    });
