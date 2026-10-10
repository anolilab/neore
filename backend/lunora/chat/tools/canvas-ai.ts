import z from "zod/v4";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";

/**
 * Canvas AI Tool
 * Applies AI image operations to a design canvas.
 * Delegates to existing image editing/generation internal actions.
 */
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { toolsLogger } from "../../lib/logger";

type CanvasAIOperation = "remove_background" | "upscale" | "style_transfer" | "generate_element";

const canvasAITool = createTool<
    {
        documentId: string;
        operation: CanvasAIOperation;
        prompt?: string;
    },
    {
        documentId: string;
        error?: string;
        message: string;
        operation: string;
        resultUrl?: string;
    },
    ToolContext
>({
    description: `Apply AI-powered operations to a design canvas or generate new image elements for it.

Available operations:
- remove_background: Export the canvas as PNG, remove its background, return the result URL
- upscale: Export the canvas as PNG and upscale to higher resolution
- style_transfer: Apply an artistic style to the canvas (requires prompt describing the style)
- generate_element: Generate a new image from a prompt, to be added to the canvas as a FabricImage element

After getting the resultUrl, use updateDesign to add/replace canvas content.
For generate_element, add the result as a FabricImage object in the canvas JSON objects array.`,
    execute: async (context, input) => {
        const { documentId, operation, prompt } = input;

        if (!context.threadId || !context.userId) {
            throw new Error("Cannot use canvas AI: no active thread or user");
        }

        toolsLogger.debug(`[canvasAI] Operation: ${operation} on document ${documentId}`);

        try {
            if (operation === "generate_element") {
                if (!prompt) {
                    return {
                        documentId,
                        error: "Missing prompt",
                        message: "generate_element operation requires a prompt",
                        operation,
                    };
                }

                // Use image generation internal action
                const result = await context.runAction(internal.chat.functions.generateImage, {
                    imageSize: "1:1",
                    model: "fal:flux-dev",
                    numImages: 1,
                    prompt,
                    threadId: context.threadId,
                    userId: context.userId,
                });

                const imageUrl = result.assets[0]?.imageUrl;

                if (!imageUrl) {
                    return {
                        documentId,
                        error: "No image generated",
                        message: "Image generation returned no results",
                        operation,
                    };
                }

                toolsLogger.debug(`[canvasAI] Generated element image: ${imageUrl.slice(0, 50)}...`);

                return {
                    documentId,
                    message: `Generated image element. Add it to the canvas JSON objects array as: { "type": "Image", "src": "${imageUrl}", "left": 100, "top": 100, "scaleX": 0.5, "scaleY": 0.5 }`,
                    operation,
                    resultUrl: imageUrl,
                };
            }

            // For canvas-wide operations, use the document's PNG preview
            // The preview is stored in the document's content field as a data URL
            const documentRow = await context.runMutation(internal.agent.documents.updateDocumentInternal, {
                documentId: documentId as Id<"documents">,
                messageId: context.messageId,
            });

            if (!documentRow) {
                return {
                    documentId,
                    error: "Document not found",
                    message: "Design document not found",
                    operation,
                };
            }

            // Use image editing internal action
            const editOperation = operation === "remove_background" || operation === "upscale" ? operation : "style_transfer";
            const editResult = await context.runAction(internal.chat.functions.editImage, {
                imageUrl: documentRow.content ?? "",
                operation: editOperation,
                prompt,
            });

            let actionLabel = "Applied style transfer to";

            if (operation === "remove_background") {
                actionLabel = "Removed background from";
            } else if (operation === "upscale") {
                actionLabel = "Upscaled";
            }

            toolsLogger.debug(`[canvasAI] ${actionLabel} canvas: ${editResult.resultUrl.slice(0, 50)}...`);

            return {
                documentId,
                message: `${actionLabel} canvas. Result available at the returned URL.`,
                operation,
                resultUrl: editResult.resultUrl,
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            toolsLogger.error(`[canvasAI] ${operation} failed: ${errorMessage}`);

            return {
                documentId,
                error: errorMessage,
                message: `Operation failed: ${errorMessage}`,
                operation,
            };
        }
    },
    inputSchema: z
        .object({
            documentId: z.string().min(1).meta({ description: "The ID of the design document" }),
            operation: z.enum(["remove_background", "upscale", "style_transfer", "generate_element"]).meta({ description: "The AI operation to perform" }),
            prompt: z.string().optional().meta({ description: "Text description for style_transfer or generate_element operations" }),
        })
        .strict(),
    title: "Canvas AI",
});

export default canvasAITool;
