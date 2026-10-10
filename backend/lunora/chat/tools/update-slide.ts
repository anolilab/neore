import z from "zod/v4";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";

/**
 * Update Slide Tool
 * Updates a single slide within an existing presentation.
 * Used when the user asks the AI to edit, regenerate, or modify a specific slide.
 */
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { toolsLogger } from "../../lib/logger";

const updateSlideTool = createTool<
    {
        htmlContent?: string;
        presentationId: string;
        slideNumber: number;
        title?: string;
    },
    {
        presentationId: string;
        slideNumber: number;
        title: string;
    },
    ToolContext
>({
    description: `Update a single slide in an existing presentation. Use this when the user asks you to edit, modify, regenerate, or fix a specific slide in a presentation that was already created.

Provide the presentationId (from a previous createPresentation result) and the 1-based slideNumber to update. You can update the title, the HTML content, or both.

When updating htmlContent, provide the COMPLETE new HTML for the slide — this replaces the entire slide content. Follow the same HTML guidelines as createPresentation:
- Write inner body HTML (no doctype/html/head/body tags)
- Use inline styles
- Target 1920×1080 pixel viewport
- Maintain visual consistency with the rest of the presentation`,
    execute: async (context, input) => {
        const { htmlContent, presentationId, slideNumber, title } = input;

        if (!context.threadId) {
            throw new Error("Cannot update slide: no active thread");
        }

        if (!context.userId) {
            throw new Error("Cannot update slide: no authenticated user");
        }

        if (!title && !htmlContent) {
            throw new Error("Must provide at least one of title or htmlContent to update");
        }

        toolsLogger.debug(`[updateSlide] Updating slide ${slideNumber} of presentation ${presentationId}`);

        const { slideId } = await context.runMutation(internal.chat.slides.internal.updateSlide, {
            htmlContent,
            presentationId: presentationId as Id<"presentations">,
            slideNumber,
            threadId: context.threadId as Id<"threads">,
            title,
            userId: context.userId,
        });

        toolsLogger.debug(`[updateSlide] Updated slide ${slideId}`);

        // Fetch updated slide info for the response
        return {
            presentationId,
            slideNumber,
            title: title ?? `Slide ${slideNumber}`,
        };
    },
    inputSchema: z
        .object({
            htmlContent: z.string().min(1).optional().meta({ description: "Optional new HTML content for the slide (replaces entire slide body)" }),
            presentationId: z.string().min(1).meta({ description: "The ID of the presentation (from a previous createPresentation result)" }),
            slideNumber: z.int().min(1).meta({ description: "The 1-based slide number to update" }),
            title: z.string().min(1).optional().meta({ description: "Optional new title for the slide" }),
        })
        .strict(),
    title: "Update Slide",
});

export default updateSlideTool;
