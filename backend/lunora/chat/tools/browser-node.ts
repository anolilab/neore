/**
 * Browser Automation Node Action
 *
 * Internal action that drives a headless browser through the Cloudflare
 * Browser Rendering worker.
 * Each invocation either reuses an existing session (by thread) or creates a new one.
 *
 * Supports: navigate, screenshot, click, type, extract, scroll.
 */
import { browserAction, type BrowserActionRequest, type BrowserActionResponse, createBrowserRendererClient } from "@neore/service-sdk/browser-renderer";
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/internal";
import { internalAction } from "../../_generated/server";
import { browserIdOf, NO_PROVIDER_SESSION, rendererCallBudget, rendererCallHold } from "../../browser/live-view-logic";
import { isServiceBound, serviceFetch } from "../../lib/services";
import { type ClickTargetLook, purchaseTargetNeedsApproval } from "../lib/purchase-gate";
import { validateDomain } from "./utilities";

("use node");

/** What a session row records as its `connectUrl`: the renderer has no URL any more, only a binding. */
export const BROWSER_RENDERER_CONNECT = "service:browserRenderer";

export const executeBrowserAction = internalAction
    .input({
        action: v.union(v.literal("navigate"), v.literal("screenshot"), v.literal("click"), v.literal("type"), v.literal("extract"), v.literal("scroll")),
        /**
         * The approval preread of a click (`chat/tools/browser.ts`): a read of the target before the person says yes. It is a
         * look the agent did not ask for, so it does not end a person's hand-back lease, and the agent's next action still
         * looks first. Only `chat/tools/browser.ts` sets it, as `ladderLook` is set.
         */
        approvalLook: v.optional(v.boolean()),
        /**
         * A click the person approved (`chat/tools/browser.ts`): it is checked against the target its decision look recorded
         * for this tool call (`decisionCallId`), so a page that changed since they were shown it is refused.
         */
        approvedCallId: v.optional(v.string()),
        /** An `ask`-mode decision look (`chat/tools/browser.ts`): every target it reads is recorded, since every call asks. */
        askDecision: v.optional(v.boolean()),
        browserSettings: v.optional(v.any()),
        /** How this click is dispatched (`browserClickMode`, chosen by the tool): see the renderer's `clickMode`. */
        clickMode: v.optional(v.union(v.literal("page"), v.literal("pointer"), v.literal("all"))),
        /** The approval look of this tool call: its target is recorded for the decision, so the approved click can be checked against it. */
        decisionCallId: v.optional(v.string()),
        direction: v.optional(v.string()),
        /** A click the tool checked itself (a look before it was not asked to ask): the target that look read. */
        expectTarget: v.optional(v.string()),
        fullPage: v.optional(v.boolean()),
        /**
         * One of the human-check ladder's own reads (`browser/human-check.ts`), which the agent never asked for: not
         * charged to the user's browser rate limit. Only `chat/tools/browser.ts` sets it, capped per tool call
         * (`HUMAN_CHECK_LOOK_BUDGET`); an internal action, so no client or model input reaches it.
         */
        ladderLook: v.optional(v.boolean()),
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
            // The session this call acts on, once it is known: a decision look that fails records its empty target there.
            let decisionSession: Id<"browserSessions"> | undefined;
            // The rate-limit charge's refund, once the charge is made, and whether the renderer call was sent: a failure before the
            // send gives the charge back, so a failed attempt does not use up an hourly action.
            let refundCharge: (() => Promise<void>) | undefined;
            let mayHaveSent = false;
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
                    throw new LunoraError("SERVICE_UNAVAILABLE", "The browser session could not be opened. Try it again.");
                }

                // What the row named when this action started: its result is written only if no other action moved it on.
                const startedWithProviderSessionId = sessionDocument.providerSessionId ?? null;
                const cfSessionId = sessionDocument.providerSessionId === NO_PROVIDER_SESSION ? undefined : sessionDocument.providerSessionId;
                const sessionId = sessionDocument._id;

                decisionSession = sessionId;

                // The approved click's target is taken further down, once the hold and the rate limit have let this action run.

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

                // Rate limiting: only an action that runs is counted, not one refused while a person drives the browser, nor one the
                // renderer refused unrun (`refund`). Not counted either: the human-check ladder's own reads, and a click's approval
                // read (the click itself is counted once), so a click that needs no approval is not charged for its reads.
                const isUncounted = args.ladderLook === true || args.approvalLook === true;
                const rateKey = `browser/action:${args.userTier ?? "free"}`;
                const rlResult = isUncounted
                    ? { ok: true }
                    : await ctx.runMutation(internal.lib.rate_limiter_mutations.applyRateLimit, { identifier: userId, key: rateKey });

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

                /** Gives back the charge of an action the renderer ran none of (a sign-in held it, it was retired, its lock did not answer). */
                const refund = async (): Promise<void> => {
                    if (!isUncounted) {
                        await ctx.runMutation(internal.lib.rate_limiter_mutations.refundRateLimit, { identifier: userId, key: rateKey });
                    }
                };

                refundCharge = refund;

                // After a hand back the page is not the one the agent planned against: it looks before it acts. A
                // navigate to a browser that was closed runs as asked: there is no page left to look at.
                const reopens = action === "navigate" && (returned === "browser_closed" || cfSessionId === undefined);
                const looksFirst = returned !== undefined && action !== "screenshot" && action !== "extract" && !reopens;

                const client = createBrowserRendererClient({ fetch: serviceFetch(ctx, "browserRenderer") });
                // A call that starts late is cut off before its hold ends, never after it; one too late for any of it is not sent.
                const budget = rendererCallBudget(held.until, Date.now());

                if (budget === 0) {
                    throw new LunoraError("CONFLICT", "The action started too late and was not sent. Try it again.");
                }

                callSignal = AbortSignal.timeout(budget);
                callEndsBy = Date.now() + budget;

                // A click the person approved is checked against the target its decision read recorded. It is taken here, once the hold
                // and the rate limit have let this action run, so a refusal before the press keeps the record (the approval stays
                // usable). A look-first screenshot does not send the click, so it takes nothing.
                let approvedTarget: string | undefined;

                if (action === "click" && args.approvedCallId !== undefined && !looksFirst) {
                    const taken = await ctx.runMutation(internal.browser.functions.takePurchaseLook, { sessionId, toolCallId: args.approvedCallId });

                    // The look read the page on the browser the approval names: a click sent to another browser (the provider replaced
                    // this one while the person was asked, or the look predates the record) is refused, since the target the person saw
                    // is not known to be on that browser.
                    if (taken.kind !== "target" || taken.target === undefined || taken.browser !== (cfSessionId ?? NO_PROVIDER_SESSION)) {
                        await ctx.runMutation(internal.browser.functions.endSessionUse, held);
                        await refund();

                        const unknown = { error: APPROVED_TARGET_UNKNOWN, success: false };

                        return returned === undefined ? unknown : handedBackResult(unknown, returned);
                    }

                    approvedTarget = taken.target;
                }

                // A click the person approved is checked against the target they were shown (taken above). Otherwise a click the
                // tool checked itself carries its own `expectTarget`.
                let expectTarget: string | undefined;

                if (action === "click") {
                    expectTarget = args.approvedCallId === undefined ? args.expectTarget : approvedTarget;
                }

                const sent: BrowserActionRequest = looksFirst
                    ? { action: "screenshot", sessionId: cfSessionId }
                    : {
                          action,
                          direction: args.direction as "up" | "down" | undefined,
                          ...(args.clickMode !== undefined && action === "click" && { clickMode: args.clickMode }),
                          // An approved click is the one a person saw: an element hidden by opacity is refused for it (the renderer checks it).
                          ...(action === "click" && args.approvedCallId !== undefined && { strictVisibility: true }),
                          ...(expectTarget !== undefined && { expectTarget }),
                          fullPage: args.fullPage,
                          selector: args.selector,
                          sessionId: cfSessionId,
                          text: args.text,
                          url: args.url,
                          ...(args.approvalLook === true && { visibleOnly: true }),
                      };

                mayHaveSent = true;
                let { data, error, response } = await browserAction({ body: sent, client, signal: callSignal });
                // The row's browser when the result below is logged: none, once a retired one is dropped.
                let startedWith = startedWithProviderSessionId;

                // The renderer retired the session for good (a sign-in on it could not confirm its page clean): its id is
                // dropped from the row first, so a retry that fails or throws leaves it there no more, and is never sent
                // again. A navigate runs at once on a new browser; any other action needs a page first.
                if (response?.status === 410 && sent.action === "navigate" && sent.sessionId !== undefined) {
                    // This action's hold is kept for the retry: no `heldUntil`.
                    const dropped = await ctx.runMutation(internal.browser.functions.logAction, {
                        action: sent.action,
                        durationMs: Date.now() - startTime,
                        errorMessage: BROWSER_SESSION_RETIRED,
                        providerSessionId: NO_PROVIDER_SESSION,
                        sessionId,
                        startedAt: startTime,
                        startedWithProviderSessionId,
                        success: false,
                    });

                    // Another action moved the row on meanwhile: its browser is the thread's, and this one opens none beside it.
                    if (dropped.closed === true || dropped.replaced) {
                        await ctx.runMutation(internal.browser.functions.endSessionUse, held);
                        await refund();

                        const discarded =
                            dropped.closed === true ? { error: BROWSER_CLOSED_DURING_ACTION, success: false } : browserReplacedResult(dropped.currentUrl);

                        return returned === undefined ? discarded : handedBackResult(discarded, returned);
                    }

                    startedWith = NO_PROVIDER_SESSION;

                    // The call's time ran out while the retired id was dropped: the retry is not sent, so nothing runs in the
                    // renderer, and the hold and the charge are given back here (a retry sent with a spent signal would throw
                    // and read as a call that may still act).
                    if (callSignal.aborted || Date.now() >= callEndsBy) {
                        await ctx.runMutation(internal.browser.functions.endSessionUse, held);
                        await refund();

                        const retired = { error: BROWSER_SESSION_RETIRED, success: false };

                        return returned === undefined ? retired : handedBackResult(retired, returned);
                    }

                    ({ data, error, response } = await browserAction({ body: { ...sent, sessionId: undefined }, client, signal: callSignal }));
                }

                if (response?.status === 410) {
                    await ctx.runMutation(internal.browser.functions.logAction, {
                        action: sent.action,
                        durationMs: Date.now() - startTime,
                        errorMessage: BROWSER_SESSION_RETIRED,
                        heldReaped: held.reaped,
                        heldUntil: held.until,
                        // No reusable browser: the next action opens a new one.
                        providerSessionId: NO_PROVIDER_SESSION,
                        sessionId,
                        startedAt: startTime,
                        startedWithProviderSessionId: startedWith,
                        success: false,
                    });

                    await refund();

                    const retired = { error: BROWSER_SESSION_RETIRED, success: false };

                    return returned === undefined ? retired : handedBackResult(retired, returned);
                }

                // A sign-in with a saved login holds the browser: the renderer ran nothing, so the hold ends here.
                if (response?.status === 409) {
                    await ctx.runMutation(internal.browser.functions.endSessionUse, held);
                    await refund();

                    // Nothing ran, so an approved click keeps the target it was checked against: its retry with the same approval is
                    // still checked, rather than refused as unknown. (A click that did run keeps its record consumed.)
                    if (args.approvedCallId !== undefined && approvedTarget !== undefined) {
                        await ctx
                            .runMutation(internal.browser.functions.recordPurchaseLook, {
                                browser: cfSessionId ?? NO_PROVIDER_SESSION,
                                sessionId,
                                target: approvedTarget,
                                toolCallId: args.approvedCallId,
                            })
                            .catch(() => undefined);
                    }

                    const busy = { error: BROWSER_BUSY_SIGNING_IN, success: false };

                    return returned === undefined ? busy : handedBackResult(busy, returned);
                }

                // The renderer lost the session's hold during the action: it may have run, so its charge is kept, the browser
                // it names (a new one, for a first action) stays the thread's, and the agent is told to look before repeating it.
                if (response?.status === 503 && response.headers?.get?.("x-browser-action") !== "not-run") {
                    const lapsed = (error ?? {}) as { error?: unknown; sessionId?: unknown };
                    const message = typeof lapsed.error === "string" ? lapsed.error : "The action may have run: look at the page before you repeat it.";
                    const logged = await ctx.runMutation(internal.browser.functions.logAction, {
                        action: sent.action,
                        durationMs: Date.now() - startTime,
                        errorMessage: message,
                        heldReaped: held.reaped,
                        heldUntil: held.until,
                        // No id: the lost hold closed the browser it ran on, or none was named; the row keeps what it has.
                        ...(typeof lapsed.sessionId === "string" && { providerSessionId: lapsed.sessionId }),
                        sessionId,
                        startedAt: startTime,
                        startedWithProviderSessionId: startedWith,
                        success: false,
                    });
                    let lapsedResult: { error: string; success: false; url?: string } = { error: message, success: false };

                    if (logged.closed === true) {
                        lapsedResult = { error: BROWSER_CLOSED_DURING_ACTION, success: false };
                    } else if (logged.replaced) {
                        lapsedResult = browserReplacedResult(logged.currentUrl);
                    }

                    return returned === undefined ? lapsedResult : handedBackResult(lapsedResult, returned);
                }

                if (error || !response?.ok || !data) {
                    // The renderer says it ran nothing (its session lock did not answer): the charge is given back, and
                    // the hold ends here, however late the answer came: no call of this action can still be acting.
                    if (response?.headers?.get?.("x-browser-action") === "not-run") {
                        const ended = held;

                        held = undefined;
                        await ctx.runMutation(internal.browser.functions.endSessionUse, ended).catch(() => undefined);
                        await refund();
                    }

                    throw new LunoraError("INTERNAL", `Browser renderer returned ${response?.status ?? "no response"}: ${JSON.stringify(error)}`);
                }

                const result = data as BrowserActionResponse;

                // The renderer refused the click before it pressed anything (the target changed since the check): nothing ran, so the
                // charge is given back, and the retry is charged once. A press that ran (`pressed`, `moved`) keeps its charge.
                if (result.targetChanged === true && refundCharge !== undefined) {
                    await refundCharge().catch(() => undefined);
                }

                const durationMs = Date.now() - startTime;

                // The decision look of a tool call: a look that reads as a purchase (or cannot be read) keeps its target, so the click
                // the person approves is checked against it. A look that read no target keeps an empty one, so that click is refused.
                // An ordinary look keeps nothing: its click is not approved, so there is no record to clear later.
                if (args.decisionCallId !== undefined && (args.askDecision === true || purchaseTargetNeedsApproval(result as ClickTargetLook))) {
                    await ctx.runMutation(internal.browser.functions.recordPurchaseLook, {
                        browser: result.sessionId ?? cfSessionId ?? NO_PROVIDER_SESSION,
                        sessionId,
                        target: result.success === true && result.target !== undefined ? result.target : "",
                        toolCallId: args.decisionCallId,
                    });
                }

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
                    ...(inspecting !== undefined && result.success === true && args.approvalLook !== true && { inspected: inspecting }),
                    providerSessionId: returnedSessionId,
                    sessionId,
                    startedAt: startTime,
                    startedWithProviderSessionId: startedWith,
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

                // The browser this page is on, by the name a "Needs you" card keeps (`browserIdOf`): a check it shows is
                // asked about on this browser, never on one that replaced it later. No reusable browser, no name.
                const seen = returnedSessionId === NO_PROVIDER_SESSION ? result : { ...result, browserId: await browserIdOf(sessionId, returnedSessionId) };

                if (returned === undefined) {
                    // A navigate, or a click, a typed entry or a scroll that left the page on another URL: the human-check
                    // ladder reads that page's text once (`browser/human-check.ts`), as these results carry none. A navigate's
                    // title and URL can look ordinary on a check that only its text shows.
                    const navigated =
                        result.success === true &&
                        ((action === "navigate" && result.content === undefined) ||
                            (INTERACTIVE_ACTIONS.has(action) &&
                                result.url !== undefined &&
                                sessionDocument.currentUrl !== undefined &&
                                withoutHash(result.url) !== withoutHash(sessionDocument.currentUrl)));

                    return navigated ? { ...seen, navigated: true } : seen;
                }

                return handedBackResult(seen, returned, looksFirst ? action : undefined);
            } catch (error) {
                // Whether the browser survived is unknown: the row falls back to its last confirmed activity. A call cut off
                // at its deadline may still be acting in the renderer: its hold runs out on its own, so no person takes
                // control while it lands.
                // The signal, as the clock may lag the timer that fired it.
                const mayStillAct = callSignal?.aborted === true || (callEndsBy !== undefined && Date.now() >= callEndsBy);

                if (held !== undefined && !mayStillAct) {
                    await ctx.runMutation(internal.browser.functions.endSessionUse, held).catch(() => undefined);
                }

                // A decision look that failed read no target: its record is kept empty, so the click the person approves is refused
                // rather than run unchecked. (The check fails closed; the record is replaced by the next decision's look.)
                if (args.decisionCallId !== undefined && decisionSession !== undefined) {
                    await ctx
                        .runMutation(internal.browser.functions.recordPurchaseLook, {
                            browser: NO_PROVIDER_SESSION,
                            sessionId: decisionSession,
                            target: "",
                            toolCallId: args.decisionCallId,
                        })
                        .catch(() => undefined);
                }

                // Nothing reached the renderer and the charge was made: give it back.
                if (!mayHaveSent && refundCharge !== undefined) {
                    await refundCharge().catch(() => undefined);
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

/**
 * A `#fragment` change is the same page: it is no navigation to read again. A query change is one: a search form sent
 * from a click lands on a new query, and an interstitial there need not add its token to the URL. The read is not
 * charged to the user's rate limit, and is capped per tool call (`HUMAN_CHECK_LOOK_BUDGET`).
 */
const withoutHash = (url: string): string => url.split("#", 1)[0] ?? url;

/** The actions whose result carries the page's URL but neither its title nor its text. */
const INTERACTIVE_ACTIONS: ReadonlySet<string> = new Set(["click", "scroll", "type"]);

export type BrowserReturn = "browser_closed" | "handed_back" | "idle" | "left";

/** An approved click whose target is no longer known (pushed out of its decision's record, or never read): nothing is clicked. */
export const APPROVED_TARGET_UNKNOWN =
    "The target the person approved is no longer known, so nothing was clicked. Look at the page again, and ask for approval before you click.";

/** What the agent hears while a person drives the browser from the live view: it never acts beside their input. */
export const PERSON_HAS_CONTROL =
    "The person watching this chat has taken control of the browser and is using it now, so this action was not run. Do not use the browser until they hand it back: tell them what you are waiting for, or ask them, and try again later.";

/** The session was closed just before the action reached it: nothing was sent, and the next action starts a new browser. */
export const BROWSER_CLOSED_BEFORE_ACTION =
    "The browser session was closed just before this action, so it was not run. Run it again if it is still needed: the next action opens a new, empty browser, so navigate to the page you need first.";

/** The renderer refused the action: a sign-in with a saved login holds the browser for now. */
export const BROWSER_BUSY_SIGNING_IN = "The browser is busy signing in with a saved login, so this action was not run. Try it again in a moment.";

/** The renderer retired the session for good: its browser is never used again, and the next action opens a new one. */
export const BROWSER_SESSION_RETIRED =
    "The browser session was retired and cannot be used again, so this action was not run. The next action opens a new, empty browser: navigate to the page you need first.";

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
export const handedBackResult = <T extends { error?: string; success?: boolean; url?: string }>(
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
export const browserReplacedResult = (keptUrl: string | undefined): { error: string; success: false; url?: string } => {
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

export const sanitizeBrowserError = (error: unknown): string => {
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
