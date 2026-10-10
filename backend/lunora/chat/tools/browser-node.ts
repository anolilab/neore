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

import { internal } from "../../_generated/internal";
import { internalAction } from "../../_generated/server";
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

            try {
                // Check for existing CF session to enable multi-step workflows
                let sessionDocument = await ctx.runQuery(internal.browser.functions.getActiveSession, { threadId });
                const cfSessionId = sessionDocument?.providerSessionId === "cf-browser-rendering" ? undefined : sessionDocument?.providerSessionId;

                const client = createBrowserRendererClient({ fetch: serviceFetch(ctx, "browserRenderer") });

                const { data, error, response } = await browserAction({
                    body: {
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

                // Store the CF session ID so subsequent actions reuse the same browser
                const returnedSessionId = result.sessionId ?? "cf-browser-rendering";

                if (!sessionDocument) {
                    const newSessionId = await ctx.runMutation(internal.browser.functions.createSession, {
                        connectUrl: BROWSER_RENDERER_CONNECT,
                        providerSessionId: returnedSessionId,
                        threadId,
                        userId,
                    });

                    sessionDocument = { _id: newSessionId } as any;
                } else if (returnedSessionId !== sessionDocument.providerSessionId) {
                    // Session was recreated (old one expired) — update the stored ID
                    await ctx.runMutation(internal.browser.functions.updateSession, {
                        providerSessionId: returnedSessionId,
                        sessionId: sessionDocument._id,
                    });
                }

                await ctx.runMutation(internal.browser.functions.logAction, {
                    action,
                    durationMs,
                    errorMessage: result.error,
                    sessionId: sessionDocument!._id,
                    success: result.success ?? false,
                    target: args.url ?? args.selector,
                    value: args.text,
                });

                return result;
            } catch (error) {
                return {
                    error: `CF Browser Rendering error: ${sanitizeBrowserError(error)}`,
                    success: false,
                };
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
