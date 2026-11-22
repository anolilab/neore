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
import { budgetedLook, HUMAN_CHECK_HAND_BACK_WINDOW_MS, humanCheckLadder, humanCheckMessages, waitUnlessStopped } from "../../browser/human-check";
import { toolsLogger } from "../../lib/logger";
import { approvedToolCallIds, browserActionNeedsPurchaseApproval, type ClickTargetLook, purchaseTargetNeedsApproval } from "../lib/purchase-gate";
import toonEncodeOutput from "./toon-encode";

/** A click that reads as a purchase, or whose target cannot be read, runs only once the person has said yes to it. */
const CLICK_NEEDS_APPROVAL =
    "This click reads as a purchase, or its target cannot be read, so it needs the person's approval. Look at the page again before you click.";

export interface BrowserResult {
    /** The browser the page is on (`browser-node.ts`); for the ladder's ask only, never the model. */
    browserId?: string;
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
    humanCheck?: { browserId?: string; site: string; status: "already_asked" | "asked" };
    /** The accessible name of the element a look read (`visibleOnly`). */
    label?: string;
    checkout?: boolean;
    labelTruncated?: boolean;
    /** A navigate, or an interactive action that left the page on another URL (`browser-node.ts`); for the ladder only, never the model. */
    navigated?: boolean;
    result?: string;
    screenshot?: string;
    screenshotFormat?: string;
    scrollPosition?: { maxY: number; x: number; y: number };
    success: boolean;
    /** The fingerprint of the element a look read: a click is checked against it (`expectTarget`). */
    target?: string;
    title?: string;
    truncated?: boolean;
    typedSelector?: string;
    typedText?: string;
    url?: string;
}

/**
 * Browser Automation Tool
 */
const browserTool = createTool<
    {
        action: "navigate" | "screenshot" | "click" | "type" | "extract" | "scroll" | "needs_person";
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
                action: Exclude<typeof input.action, "needs_person">;
                approvalLook?: true;
                approvedCallId?: string;
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

        try {
            const reported = action === "needs_person";
            // A click is checked against the target the person was shown. One they approved is checked against the target its
            // decision recorded (`approvedCallId`). Any other click is looked at now, and refused when that look reads as a
            // purchase: a purchase needs the person's yes, which this call was not given (its decision read was not one).
            let step: Parameters<typeof run>[0] = action === "needs_person" ? { action: "screenshot" } : { ...input, action };

            if (action === "click" && input.selector !== undefined) {
                if (approvedToolCallIds(options.messages).has(options.toolCallId)) {
                    step = { ...step, approvedCallId: options.toolCallId };
                } else {
                    const look = await run({ action: "extract", approvalLook: true, selector: input.selector });

                    if (purchaseTargetNeedsApproval(look as ClickTargetLook)) {
                        return { error: CLICK_NEEDS_APPROVAL, success: false };
                    }

                    step = { ...step, expectTarget: look.target };
                }
            }

            const first = await run(step);
            // A refused or failed action (a person in control, the browser closed) is not a page to judge.
            const result =
                first.success === true || first.handedBack === true
                    ? await humanCheckLadder(
                          first,
                          {
                              claimAsk: async (site, kind) =>
                                  await context.runMutation(internal.browser.functions.claimHumanCheckAsk, {
                                      ...(kind === "reported" && { reported: true }),
                                      ...(kind === "detected_in_text" && { inText: true }),
                                      run: runKey,
                                      site,
                                      threadId,
                                  }),
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
                .enum(["navigate", "screenshot", "click", "type", "extract", "scroll", "needs_person"])
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

        return await browserActionNeedsPurchaseApproval(
            input,
            async (selector) =>
                (await context.runAction(internal.chat.tools.browser_node.executeBrowserAction, {
                    action: "extract",
                    approvalLook: true,
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

export default browserTool;
