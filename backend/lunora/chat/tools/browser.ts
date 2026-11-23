import z from "zod/v4";

import type { Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/internal";

/**
 * Browser Automation Tool
 *
 * Gives the AI agent the ability to control a cloud browser (Cloudflare Browser Rendering).
 * Supports navigation, screenshots, clicking, typing, text extraction, scrolling,
 * and JavaScript evaluation.
 *
 * Sessions persist across tool calls within the same thread so the AI can chain
 * actions (e.g. navigate → click → screenshot).
 */
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import {
    budgetedLook,
    HUMAN_CHECK_ANSWER_POLL_MS,
    HUMAN_CHECK_ANSWER_WAIT_MS,
    HUMAN_CHECK_HAND_BACK_WINDOW_MS,
    humanCheckLadder,
    humanCheckMessages,
    humanCheckSite,
    waitUnlessStopped,
} from "../../browser/human-check";
import { toolsLogger } from "../../lib/logger";
import { approvedToolCallIds, browserActionNeedsPurchaseApproval, type ClickTargetLook, purchaseTargetNeedsApproval } from "../lib/purchase-gate";
import toonEncodeOutput from "./toon-encode";

/** A click that reads as a purchase, or whose target cannot be read, runs only once the person has said yes to it. */
const CLICK_NEEDS_APPROVAL =
    "This click reads as a purchase, or its target cannot be read, so it needs the person's approval. Look at the page again before you click.";

export interface BrowserResult {
    /** The browser the page is on (`browser-node.ts`); for the ladder's ask only, never the model. */
    browserId?: string;
    /** The element is on a checkout (`visibleOnly` reads only): a submit-like label there asks. */
    checkout?: boolean;
    clickedSelector?: string;
    content?: string;
    direction?: string;
    error?: string;
    /** The person had driven the browser and gave it back: this result is the first look since. */
    handedBack?: boolean;
    /**
     * The page needs a person (`browser/human-check.ts`): `asked` shows the "Needs you" card in the chat, which offers
     * Take control only while the thread's browser is still `browserId` (the one that showed the check, named by the
     * action that ran on it) and on `site`.
     */
    humanCheck?: { browserId?: string; checkId?: string; site: string; status: "already_asked" | "asked" | "declined" };
    /** The accessible name of the element a look read (`visibleOnly`). */
    label?: string;
    labelTruncated?: boolean;
    /** A navigate, or an interactive action that left the page on another URL (`browser-node.ts`); for the ladder only, never the model. */
    navigated?: boolean;
    result?: string;
    screenshot?: string;
    screenshotFormat?: string;
    scrollPosition?: { maxY: number; x: number; y: number };
    /** One of the element's name sources is exactly a submit word (`visibleOnly` reads): on a checkout it is the payment. */
    submitLike?: boolean;
    success: boolean;
    /** The fingerprint of the element a look read: a click is checked against it (`expectTarget`). */
    target?: string;
    /** A click was refused because its target changed since it was checked; nothing was clicked (the renderer's answer). */
    targetChanged?: boolean;
    title?: string;
    truncated?: boolean;
    typedSelector?: string;
    typedText?: string;
    url?: string;
}

type AnswerContext = Pick<ToolContext, "runMutation" | "runQuery">;

/** The person's answer on this reply's ask about `site`, `null` when there is none. */
const answerOn = async (context: Pick<ToolContext, "runQuery">, threadId: Id<"threads">, run: string, site: string) =>
    await context.runQuery(internal.browser.functions.humanCheckAnswer, { askedSince: Date.now() - HUMAN_CHECK_HAND_BACK_WINDOW_MS, run, site, threadId });

/** A navigate to a site the person declined in this reply opens nothing: their card said the agent stays off it. */
const declinedTarget = async (
    context: Pick<ToolContext, "runQuery">,
    threadId: Id<"threads">,
    run: string,
    url: string | undefined,
): Promise<BrowserResult | undefined> => {
    const site = humanCheckSite(url);
    const answer = site === "" ? null : await answerOn(context, threadId, run, site);

    return answer?.answer === "declined"
        ? { error: humanCheckMessages.answerDeclined(site), humanCheck: { site, status: "declined" }, success: false }
        : undefined;
};

/** Puts `note` in place of the "already asked" text in the result's error, else after it. */
const replaceAlreadyAsked = (result: BrowserResult, site: string, note: string): void => {
    const rest = (result.error ?? "").replace(humanCheckMessages.alreadyAsked(site), "").trim();

    result.error = rest === "" ? note : `${rest} ${note}`;
};

/**
 * Names the card a result asks the person on (`checkId`, set only for an ask this call recorded), and tells the agent
 * the person's answer on this reply's ask about the site: a decline (the card told them the agent will not use the site
 * again in this reply), also on a page that looks clear, and a done on a check that still shows. A failed read of the
 * answer leaves the result as it is: the action already ran.
 */
export const withAnswer = async (
    context: Pick<ToolContext, "runQuery">,
    threadId: Id<"threads">,
    run: string,
    result: BrowserResult,
    askIds: ReadonlyMap<string, string>,
): Promise<void> => {
    const check = result.humanCheck;

    if (check?.status === "asked") {
        const checkId = askIds.get(check.site);

        if (checkId !== undefined) {
            check.checkId = checkId;
        }

        return;
    }

    const site = check?.site ?? humanCheckSite(result.url);

    if (check === undefined && site === "") {
        return;
    }

    let latest: Awaited<ReturnType<typeof answerOn>>;

    try {
        latest = await answerOn(context, threadId, run, site);
    } catch (error) {
        toolsLogger.warn(`[BROWSER] the answer on ${site} could not be read: ${error instanceof Error ? error.message : String(error)}`);

        return;
    }

    if (latest?.answer === "declined") {
        replaceAlreadyAsked(result, site, humanCheckMessages.answerDeclined(site));
        result.humanCheck = { ...check, site, status: "declined" };
    } else if (latest?.answer === "done" && check !== undefined) {
        replaceAlreadyAsked(result, site, humanCheckMessages.answerDoneStillShows(site));
    }
};

/**
 * `wait_for_person`: the person's answer on this reply's latest card, read every {@link HUMAN_CHECK_ANSWER_POLL_MS} for
 * at most {@link HUMAN_CHECK_ANSWER_WAIT_MS}, ended early by Stop, and only once per ask (a second wait answers at
 * once). No renderer call, so no browser is held meanwhile.
 */
export const waitForAnswer = async (context: AnswerContext, threadId: Id<"threads">, run: string, signal: AbortSignal | undefined): Promise<BrowserResult> => {
    const deadline = Date.now() + HUMAN_CHECK_ANSWER_WAIT_MS;
    const askedSince = Date.now() - HUMAN_CHECK_HAND_BACK_WINDOW_MS;
    const begun = await context.runMutation(internal.browser.functions.beginHumanCheckWait, { askedSince, run, threadId });

    if (begun === null) {
        return { error: humanCheckMessages.answerNone, success: false };
    }

    // The ask the wait was recorded on, even when another action of the run asks about another site meanwhile.
    const read = async () => await context.runQuery(internal.browser.functions.humanCheckAnswer, { askedSince, run, site: begun.site, threadId });

    let latest: { answer: "declined" | "done" | "open"; site: string } = begun;

    while (latest.answer === "open" && !begun.waited && Date.now() < deadline) {
        if (!(await waitUnlessStopped(Math.min(HUMAN_CHECK_ANSWER_POLL_MS, deadline - Date.now()), signal))) {
            return { error: humanCheckMessages.answerStopped, success: false };
        }

        latest = (await read()) ?? latest;
    }

    if (latest.answer === "done") {
        return { result: humanCheckMessages.answerDone(latest.site), success: true };
    }

    return {
        error: latest.answer === "declined" ? humanCheckMessages.answerDeclined(latest.site) : humanCheckMessages.answerPending(latest.site),
        success: false,
    };
};

/**
 * Whether the user has a browser action left this hour, charged and given back at once. A click with none left reads
 * nothing: its target looks are not charged, so without this check each attempt would still open a renderer call.
 */
const hasBrowserActionLeft = async (context: ToolContext, userId: string): Promise<boolean> => {
    const key = `browser/action:${context.userTier ?? "free"}`;
    const probe = await context.runMutation(internal.lib.rate_limiter_mutations.applyRateLimit, { identifier: userId, key });

    if (probe.ok) {
        await context.runMutation(internal.lib.rate_limiter_mutations.refundRateLimit, { identifier: userId, key });
    }

    return probe.ok;
};

/**
 * Browser Automation Tool
 */
const browserTool = createTool<
    {
        action: "navigate" | "screenshot" | "click" | "type" | "extract" | "scroll" | "needs_person" | "wait_for_person";
        direction?: "up" | "down";
        fullPage?: boolean;
        selector?: string;
        text?: string;
        url?: string;
    },
    BrowserResult,
    ToolContext
>({
    description: `Control a cloud web browser to navigate pages, interact with elements, and extract data.
Available actions:
- **navigate**: Go to a URL. Requires \`url\`.
- **screenshot**: Capture the current page as an image. Optional \`fullPage\` for full-page capture.
- **click**: Click an element. Requires \`selector\` (CSS selector).
- **type**: Type text into an input field. Requires \`selector\` and \`text\`.
- **extract**: Extract text content from the page or a specific element. Optional \`selector\` to target specific element.
- **scroll**: Scroll the page. Optional \`direction\` ("up" or "down", default "down").
- **needs_person**: Ask the person to clear a page only they can (a sign-in you have no account for, or a check the browser did not catch). Shows them the page and lets them take control.
- **wait_for_person**: After the person was asked, wait a short while for their answer on the card (done or declined). Call it at most once per ask.

The browser session persists across calls, so you can chain actions: navigate → click → extract.
Never try to solve or get around a human verification, captcha or bot check, and never sign in with details you guessed. A detected check is waited out once, then the person is asked to clear it, at most once per site per task. Once they hand the browser back you are told; look at the page before you act.
Use this tool when you need to visit websites, fill forms, scrape data, or interact with web applications.`,
    execute: async (context, input, options) => {
        const { action } = input;

        toolsLogger.debug(`[BROWSER] ${action}${input.url ? ` → ${input.url}` : ""}${input.selector ? ` → ${input.selector}` : ""}`);

        if (!context.userId) {
            return { error: "Authentication required for browser automation", success: false };
        }

        if (!context.threadId) {
            return { error: "Thread context required for browser automation", success: false };
        }

        const threadId = context.threadId as Id<"threads">;
        const { userId } = context;
        // `ladderLook`: one of the human-check ladder's own reads, set here only, never from the model's input.
        const run = async (
            step: Omit<typeof input, "action"> & {
                action: Exclude<typeof input.action, "needs_person" | "wait_for_person">;
                approvalLook?: true;
                approvedCallId?: string;
                clickMode?: "page" | "pointer" | "all";
                decisionCallId?: string;
                expectTarget?: string;
                ladderLook?: true;
            },
        ): Promise<BrowserResult> =>
            (await context.runAction(internal.chat.tools.browser_node.executeBrowserAction, {
                action: step.action,
                browserSettings: (context as { browserSettings?: unknown }).browserSettings,
                direction: step.direction,
                ...(step.approvalLook === true && { approvalLook: true }),
                ...(step.approvedCallId !== undefined && { approvedCallId: step.approvedCallId }),
                ...(step.clickMode !== undefined && { clickMode: step.clickMode }),
                ...(step.decisionCallId !== undefined && { decisionCallId: step.decisionCallId }),
                ...(step.expectTarget !== undefined && { expectTarget: step.expectTarget }),
                fullPage: step.fullPage,
                ...(step.ladderLook === true && { ladderLook: true }),
                selector: step.selector,
                text: step.text,
                threadId,
                url: step.url,
                userId,
                userTier: context.userTier,
            })) as BrowserResult;
        // One ask per site per reply (`replyKey`: its first stream, the same through a pause, a resume and an approval's
        // continuation; a group turn's and a headless run's own key). A run that sets none falls back to its prompt, then the thread.
        const runKey = context.replyKey ?? (context as { promptMessageId?: string }).promptMessageId ?? threadId;

        if (action === "wait_for_person") {
            // Nobody sees a card in a headless run: there is no answer to wait for.
            return context.headless === true
                ? { error: humanCheckMessages.answerNone, success: false }
                : await waitForAnswer(context, threadId, runKey, options.abortSignal);
        }

        // The ask each site's claim recorded in this call, for its card to answer.
        const askIds = new Map<string, string>();

        try {
            const refused = action === "navigate" ? await declinedTarget(context, threadId, runKey, input.url) : undefined;

            if (refused !== undefined) {
                return refused;
            }

            const reported = action === "needs_person";
            // A click is checked against the target the person was shown. One they approved is checked against the target its
            // decision recorded (`approvedCallId`). Any other click is looked at now, and refused when that look reads as a
            // purchase: a purchase needs the person's yes, which this call was not given (its decision read was not one).
            let step: Parameters<typeof run>[0] = action === "needs_person" ? { action: "screenshot" } : { ...input, action };

            // An empty selector is no selector: the renderer refuses that click, so no look runs for it.
            if (action === "click" && input.selector) {
                // Out of browser actions this hour: refused before any look, as the renderer would refuse the click.
                if (!(await hasBrowserActionLeft(context, userId))) {
                    return { error: "Browser automation rate limit exceeded.", success: false };
                }

                // The owner's click mode (`browserClickMode`). "pointer" clicks an ordinary target for real, after the same check "all" makes
                // (the purchase check above still ran); an approved click stays in the page's checked click unless the mode is "all".
                const clickMode = await context.runQuery(internal.browser.functions.getBrowserClickMode, { userId });

                if (approvedToolCallIds(options.messages).has(options.toolCallId)) {
                    step = { ...step, approvedCallId: options.toolCallId, clickMode: clickMode === "all" ? "all" : "page" };
                } else {
                    const look = await run({ action: "extract", approvalLook: true, selector: input.selector });

                    // A selector that matches nothing fails at once, with the renderer's own error (nothing to approve).
                    if (look.error?.startsWith("Element not found") === true) {
                        return { error: look.error, success: false };
                    }

                    // A look that reads no target clears nothing: a click without a fingerprint would run unchecked.
                    if (look.target === undefined || purchaseTargetNeedsApproval(look as ClickTargetLook)) {
                        return { error: CLICK_NEEDS_APPROVAL, success: false };
                    }

                    // An ordinary click is checked against the look, then made for real ("all"); "pointer" and "all" both do that for an
                    // ordinary target. Only "page" keeps the check and the press in the page.
                    step = { ...step, clickMode: clickMode === "page" ? "page" : "all", expectTarget: look.target };
                }
            }

            let first = await run(step);

            // A click that was not approved is checked against the target looked at just before it. When the page changed in
            // between, that target is looked at once more: an ordinary target is clicked, a purchase (or one that cannot be read)
            // needs the person's yes as before. An approved click is never retried: its approval is for the target it was shown.
            if (first.targetChanged === true && step.approvedCallId === undefined && step.expectTarget !== undefined && input.selector !== undefined) {
                const again = await run({ action: "extract", approvalLook: true, selector: input.selector });

                if (again.target === undefined || purchaseTargetNeedsApproval(again as ClickTargetLook)) {
                    return { error: CLICK_NEEDS_APPROVAL, success: false };
                }

                first = await run({ ...step, expectTarget: again.target });
            }

            // A refused or failed action (a person in control, the browser closed) is not a page to judge.
            const result =
                first.success === true || first.handedBack === true
                    ? await humanCheckLadder(
                          first,
                          {
                              claimAsk: async (site, kind) => {
                                  const checkId = await context.runMutation(internal.browser.functions.claimHumanCheckAsk, {
                                      ...(kind === "reported" && { reported: true }),
                                      ...(kind === "detected_in_text" && { inText: true }),
                                      run: runKey,
                                      site,
                                      threadId,
                                  });

                                  if (checkId !== null) {
                                      askIds.set(site, checkId);
                                  }

                                  return checkId !== null;
                              },
                              // Not charged to the user's browser rate limit, so capped per tool call instead.
                              look: budgetedLook(async (kind) => await run({ action: kind, ladderLook: true }), {
                                  error: humanCheckMessages.lookBudgetSpent,
                                  success: false,
                              }),
                              // Between two actions, so no browser hold is kept and a person can take control; Stop ends it.
                              sleep: async (ms) => await waitUnlessStopped(ms, options.abortSignal),
                              wasAsked: async (site, scope) =>
                                  (await context.runQuery(internal.browser.functions.wasHumanCheckAsked, {
                                      ...(scope === "recent" && { askedSince: Date.now() - HUMAN_CHECK_HAND_BACK_WINDOW_MS }),
                                      run: runKey,
                                      site,
                                      threadId,
                                  })) ?? undefined,
                          },
                          // Only a whole page's text is read for a check: a selected element's is always short.
                          {
                              // A navigate carries no text, nor does a click, a typed entry or a scroll that moved the page on: one read looks for a check.
                              navigated: first.navigated === true,
                              readContent: action === "extract" && input.selector === undefined,
                              reported: reported && first.success === true,
                          },
                      )
                    : first;

            delete result.navigated;
            delete result.browserId;

            await withAnswer(context, threadId, runKey, result, askIds);

            toolsLogger.debug(`[BROWSER] ${action} ${result.success ? "succeeded" : "failed"}${result.error ? `: ${result.error}` : ""}`);

            return result;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            toolsLogger.error(`[BROWSER] ${action} failed: ${errorMessage}`);

            return {
                error: errorMessage,
                success: false,
            };
        }
    },
    inputSchema: z
        .object({
            action: z
                .enum(["navigate", "screenshot", "click", "type", "extract", "scroll", "needs_person", "wait_for_person"])
                .meta({ description: "The browser action to perform" }),
            direction: z.enum(["up", "down"]).optional().meta({ description: "Scroll direction (default: down)" }),
            fullPage: z.boolean().optional().meta({ description: "Capture full page screenshot (default: false)" }),
            selector: z.string().optional().meta({ description: "CSS selector for the target element (required for click, type; optional for extract)" }),
            text: z.string().optional().meta({ description: "Text to type (required for type action)" }),
            url: z.string().optional().meta({ description: "Target URL (required for navigate)" }),
        })
        .strict(),
    // A click on something that reads as a purchase asks first (`lib/purchase-gate.ts`). This is the tool's own answer,
    // so the `auto` default and a time-boxed allow do not lift it. Nothing runs without a person and a thread: `execute`
    // refuses the call then, so no look is made.
    needsApproval: async (context, input, options) => {
        if (!context.userId || !context.threadId) {
            return false;
        }

        const { threadId, userId } = context;

        // A click the hour's budget cannot run asks nothing: `execute` refuses it before any look, so no card is shown for it.
        if (input.action === "click" && input.selector && !(await hasBrowserActionLeft(context, userId))) {
            // An ask-mode preread (`askAfterLook`) reads this flag: the call cannot run, so nothing is asked for it.
            const { outcome } = options as { outcome?: { cannotRun?: boolean } };

            if (outcome !== undefined) {
                outcome.cannotRun = true;
            }

            return false;
        }

        // In `ask` mode (`looksBeforeAsk`) the call asks whatever the read says, but the read still keeps its target for the click.
        const asking = (options as { asking?: boolean }).asking === true;

        return await browserActionNeedsPurchaseApproval(
            input,
            async (selector) =>
                (await context.runAction(internal.chat.tools.browser_node.executeBrowserAction, {
                    action: "extract",
                    approvalLook: true,
                    ...(asking && { askDecision: true }),
                    browserSettings: (context as { browserSettings?: unknown }).browserSettings,
                    decisionCallId: options.toolCallId,
                    selector,
                    threadId: threadId as Id<"threads">,
                    userId,
                    userTier: context.userTier,
                })) as BrowserResult,
        );
    },
    title: "Browser",
    toModelOutput: (_context, { output }) => {
        // For screenshots, return as image content part
        if (output.screenshot && output.screenshotFormat) {
            const { screenshot, screenshotFormat, ...rest } = output;
            const textPart = toonEncodeOutput(rest);

            return {
                type: "content" as const,
                value: [
                    {
                        data: screenshot,
                        mediaType: `image/${screenshotFormat}` as `image/${string}`,
                        type: "image-data" as const,
                    },
                    {
                        text: textPart.value,
                        type: "text" as const,
                    },
                ],
            };
        }

        // For text results, use TOON encoding for token efficiency
        return toonEncodeOutput(output);
    },
});

// `ask` mode reads a click's target before it asks, and keeps it for the approved click (`lib/tool-permissions.ts`).
// `readsApproval`: a checked click reads the person's approval from its `messages` (`approvedToolCallIds`), so the continuation passes it.
export default Object.assign(browserTool, { looksBeforeAsk: true as const, readsApproval: true as const });
