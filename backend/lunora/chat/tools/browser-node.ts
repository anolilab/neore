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
import { NO_PROVIDER_SESSION } from "../../browser/live-view-logic";
import { FETCH_TIMEOUT_LONG_MS } from "../../lib/fetch-timeout";
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

            // Rate limiting
            const tier = args.userTier ?? "free";
            const rlResult = await ctx.runMutation(internal.lib.rate_limiter_mutations.applyRateLimit, {
                identifier: userId,
                key: `browser/action:${tier}`,
            });

            if (!rlResult.ok) {
                return { error: "Browser automation rate limit exceeded.", success: false };
            }

            const startTime = Date.now();
            // The session this action holds while it runs, and its hold's deadline; released if the action fails.
            let held: { sessionId: Id<"browserSessions">; until: number } | undefined;
            // A person's hand back this action is the first to hear of; the note reaches the agent even if the action fails.
            let returned: BrowserReturn | undefined;
            // The ended lease this action looks at the page for: once a look came back, the next actions act again.
            let inspecting: string | undefined;

            try {
                // Check for existing CF session to enable multi-step workflows
                let sessionDocument = await ctx.runQuery(internal.browser.functions.getActiveSession, { threadId });
                // What the row named when this action started: its result is written only if no other action moved it on.
                let startedWithProviderSessionId = sessionDocument?.providerSessionId ?? null;
                const cfSessionId = sessionDocument?.providerSessionId === NO_PROVIDER_SESSION ? undefined : sessionDocument?.providerSessionId;

                // A browser still alive is in use from here on, not only once the action returns: a slow action must not
                // read as idle. A reaped one is not held: its old page must not come back while the renderer replaces it.
                // The same write refuses the action while a person drives the browser, and tells of a hand back once.

                if (sessionDocument) {
                    const until = Date.now() + FETCH_TIMEOUT_LONG_MS;
                    const use = await ctx.runMutation(internal.browser.functions.beginSessionUse, { sessionId: sessionDocument._id, until });

                    if (use.controlled) {
                        return { error: PERSON_HAS_CONTROL, success: false };
                    }

                    held = use.held ? { sessionId: sessionDocument._id, until } : undefined;
                    returned = use.returned;
                    inspecting = use.inspecting;
                }

                // After a hand back the page is not the one the agent planned against: it looks before it acts.
                const looksFirst = returned !== undefined && action !== "screenshot" && action !== "extract";

                const client = createBrowserRendererClient({ fetch: serviceFetch(ctx, "browserRenderer") });

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
                    signal: AbortSignal.timeout(FETCH_TIMEOUT_LONG_MS),
                });

                if (error || !response?.ok || !data) {
                    throw new LunoraError("INTERNAL", `Browser renderer returned ${response?.status ?? "no response"}: ${JSON.stringify(error)}`);
                }

                const result = data as BrowserActionResponse;
                const durationMs = Date.now() - startTime;

                // Store the CF session ID so subsequent actions reuse the same browser. No id: the renderer kept no
                // browser (it closed it after a blocked redirect), so there is nothing to reuse or watch.
                const returnedSessionId = result.sessionId ?? NO_PROVIDER_SESSION;

                if (!sessionDocument) {
                    const newSessionId = await ctx.runMutation(internal.browser.functions.createSession, {
                        connectUrl: BROWSER_RENDERER_CONNECT,
                        providerSessionId: returnedSessionId,
                        threadId,
                        userId,
                    });

                    sessionDocument = { _id: newSessionId } as any;
                    startedWithProviderSessionId = returnedSessionId;
                }

                // One write: a replaced browser's id, the page this action left it on, the activity stamp, this action's hold's end.
                const logged = await ctx.runMutation(internal.browser.functions.logAction, {
                    action: looksFirst ? "screenshot" : action,
                    currentUrl: result.url,
                    durationMs,
                    errorMessage: result.error,
                    heldUntil: held?.until,
                    ...(inspecting !== undefined && result.success === true && { inspected: inspecting }),
                    providerSessionId: returnedSessionId,
                    sessionId: sessionDocument!._id,
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
                if (held !== undefined) {
                    // Whether the browser survived is unknown: the row falls back to its last confirmed activity.
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

type BrowserReturn = "handed_back" | "idle" | "left";

/** What the agent hears while a person drives the browser from the live view: it never acts beside their input. */
export const PERSON_HAS_CONTROL =
    "The person watching this chat has taken control of the browser and is using it now, so this action was not run. Do not use the browser until they hand it back: tell them what you are waiting for, or ask them, and try again later.";

/** The session was closed while the action ran: a later action starts from a new, empty browser. */
export const BROWSER_CLOSED_DURING_ACTION =
    "The browser session was closed while this action ran, so its result was discarded: it is not about the browser the next action will use. That browser starts empty: navigate to the page you need first.";

const RETURN_REASON: Record<BrowserReturn, string> = {
    handed_back: "handed it back",
    idle: "stopped using it, so control returned to you",
    left: "left the live view, so control returned to you",
};

/**
 * The first action after a person drove the browser: the result says so, and names the page the browser is on now. An
 * action that would change the page (`skipped`) was not run; a screenshot of the page came back in its place.
 */
const handedBackResult = <T extends { error?: string; success?: boolean; url?: string }>(result: T, returned: BrowserReturn, skipped?: string): T => {
    const page = result.url === undefined ? "The current page is unknown." : `The browser is now on ${result.url}.`;
    const note = `The person had control of the browser and ${RETURN_REASON[returned]}; the page may have changed. ${page} ${
        skipped === undefined
            ? "Look at this result again before you act."
            : `Your ${skipped} action was not run: this is a screenshot of the page instead. Look at it, then decide what to do.`
    }`;

    return { ...result, error: result.error === undefined ? note : `${note} ${result.error}`, ...(skipped !== undefined && { success: false }) };
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
