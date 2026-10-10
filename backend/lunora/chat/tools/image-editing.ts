import z from "zod/v4";

import { internal } from "../../_generated/internal";

/**
 * Image Editing Tool
 * Performs image editing operations using fal.ai APIs via an internal action.
 * Supports background removal, upscaling, style transfer, and inpainting.
 */
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { toolsLogger } from "../../lib/logger";
import { isSafeUrl } from "./utilities";

type ImageEditOperation = "remove_background" | "upscale" | "style_transfer" | "inpaint" | "face_enhance";

/**
 * URL of the image to edit.
 */
const imageEditingTool = createTool<
    {
        imageUrl: string;
        mask?: string;
        operation: ImageEditOperation;
        prompt?: string;
    },
    {
        error?: string;
        operation: string;
        resultUrl: string;
    },
    ToolContext
>({
    description: `Edit and transform images using AI.
Available operations:
- remove_background: Remove the background from an image
- upscale: Increase image resolution (2x or 4x)
- style_transfer: Apply artistic styles to an image (requires prompt describing the style)
- inpaint: Edit specific parts of an image (requires prompt and optional mask URL)
- face_enhance: Enhance and restore faces in images
Requires an image URL as input.`,
    execute: async (context, input) => {
        const { imageUrl, mask, operation, prompt } = input;

        if (!context.userId) {
            return { error: "Authentication required", operation, resultUrl: "" };
        }

        if (!isSafeUrl(imageUrl)) {
            return { error: "Invalid or unsafe image URL", operation, resultUrl: "" };
        }

        if (mask && !isSafeUrl(mask)) {
            return { error: "Invalid or unsafe mask URL", operation, resultUrl: "" };
        }

        if ((operation === "style_transfer" || operation === "inpaint") && !prompt) {
            return {
                error: `A prompt is required for ${operation}`,
                operation,
                resultUrl: "",
            };
        }

        toolsLogger.debug(`[IMAGE_EDIT] ${operation} on ${imageUrl.slice(0, 50)}...`);

        try {
            const result = await context.runAction(internal.chat.functions.editImage, {
                imageUrl,
                mask,
                operation,
                prompt,
            });

            toolsLogger.debug(`[IMAGE_EDIT] ${operation} complete: ${result.resultUrl.slice(0, 50)}...`);

            return {
                operation,
                resultUrl: result.resultUrl,
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            toolsLogger.error(`[IMAGE_EDIT] ${operation} failed: ${errorMessage}`);

            return {
                error: errorMessage,
                operation,
                resultUrl: "",
            };
        }
    },
    inputSchema: z
        .object({
            imageUrl: z.url().meta({ description: "URL of the image to edit" }),
            mask: z.url().optional().meta({ description: "Mask image URL for inpaint operation (white areas will be edited)" }),
            operation: z
                .enum(["remove_background", "upscale", "style_transfer", "inpaint", "face_enhance"])
                .meta({ description: "The editing operation to perform" }),
            prompt: z.string().optional().meta({ description: "Text description for style_transfer or inpaint operations" }),
        })
        .strict(),
    title: "Image Editing",
});

export default imageEditingTool;
