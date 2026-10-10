import z from "zod/v4";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";

/**
 * Browser Automation Tool
 *
 * Gives the AI agent the ability to control a cloud browser via Browserbase.
 * Supports navigation, screenshots, clicking, typing, text extraction, scrolling,
 * and JavaScript evaluation.
 *
 * Sessions persist across tool calls within the same thread so the AI can chain
 * actions (e.g. navigate → click → screenshot).
 */
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { toolsLogger } from "../../lib/logger";
import toonEncodeOutput from "./toon-encode";

export interface BrowserResult {
    clickedSelector?: string;
    content?: string;
    direction?: string;
    error?: string;
    result?: string;
    screenshot?: string;
    screenshotFormat?: string;
    scrollPosition?: { maxY: number; x: number; y: number };
    success: boolean;
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
        action: "navigate" | "screenshot" | "click" | "type" | "extract" | "scroll";
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

The browser session persists across calls, so you can chain actions: navigate → click → extract.
Use this tool when you need to visit websites, fill forms, scrape data, or interact with web applications.`,
    execute: async (context, input) => {
        const { action } = input;

        toolsLogger.debug(`[BROWSER] ${action}${input.url ? ` → ${input.url}` : ""}${input.selector ? ` → ${input.selector}` : ""}`);

        if (!context.userId) {
            return { error: "Authentication required for browser automation", success: false };
        }

        if (!context.threadId) {
            return { error: "Thread context required for browser automation", success: false };
        }

        try {
            const result = (await context.runAction(internal.chat.tools.browser_node.executeBrowserAction, {
                action,
                browserSettings: (context as { browserSettings?: unknown }).browserSettings,
                direction: input.direction,
                fullPage: input.fullPage,
                selector: input.selector,
                text: input.text,
                threadId: context.threadId as Id<"threads">,
                url: input.url,
                userId: context.userId,
                userTier: context.userTier,
            })) as BrowserResult;

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
            action: z.enum(["navigate", "screenshot", "click", "type", "extract", "scroll"]).meta({ description: "The browser action to perform" }),
            direction: z.enum(["up", "down"]).optional().meta({ description: "Scroll direction (default: down)" }),
            fullPage: z.boolean().optional().meta({ description: "Capture full page screenshot (default: false)" }),
            selector: z.string().optional().meta({ description: "CSS selector for the target element (required for click, type; optional for extract)" }),
            text: z.string().optional().meta({ description: "Text to type (required for type action)" }),
            url: z.string().optional().meta({ description: "Target URL (required for navigate)" }),
        })
        .strict(),
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
