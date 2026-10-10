import z from "zod/v4";

import { internal } from "../../_generated/internal";

/**
 * Image Generation Tool
 * Generates images from text descriptions using FAL.ai
 */
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { toolsLogger } from "../../lib/logger";
import { checkRateLimit } from "../../lib/rate-limiter";

const imageGenerationTool = createTool<
    {
        aspectRatio?: string;
        model?: string;
        negativePrompt?: string;
        numImages?: number;
        prompt: string;
        referenceImages?: string[];
        seed?: number;
    },
    {
        error?: string;
        images: {
            model: string;
            prompt: string;
            url: string;
        }[];
    },
    ToolContext
>({
    description: `Generate images from text descriptions using AI.
Available models include:
- FAL.ai: fal:flux-dev (fast, free), fal:flux-pro (premium), fal:sdxl-lightning (fastest)
- Google: google/gemini-2.5-flash-image (via OpenRouter)
- More providers supported - check model registry
Supports aspect ratios: auto, 1:1, 16:9, 9:16, 4:3, 3:4, 2:3, 3:2, 2:1, 1:2, 19.5:9, 9:19.5, 20:9, 9:20, 21:9.
Use 'auto' to automatically match input image's aspect ratio. Premium users can generate up to 4 images at once.`,
    execute: async (context, input) => {
        const { aspectRatio = "1:1", model = "fal:flux-dev", numImages: numberImages = 1, prompt } = input;

        if (!context.userId) {
            return { error: "Authentication required", images: [] };
        }

        // Charge the same daily image bucket the chat/http endpoint charges,
        // so this skill-driven path cannot bypass dailyImage when invoked
        // from text-mode chats. Each generated image counts.
        const tier = context.userTier === "premium" || context.userTier === "ultra" ? "premium" : "free";
        const limited = await checkRateLimit(context, `chat/dailyImage:${tier}`, {
            count: numberImages,
            key: context.userId,
            throws: false,
        });

        if (!limited.ok) {
            return { error: "Daily image generation limit reached", images: [] };
        }

        toolsLogger.debug(`[IMAGE_GEN] Generating ${numberImages} image(s) with ${model}: ${prompt.slice(0, 50)}...`);

        try {
            // Call internal action to handle generation
            const result = await context.runAction(internal.chat.functions.generateImage, {
                imageSize: aspectRatio, // Map aspectRatio to imageSize parameter
                model,
                negativePrompt: input.negativePrompt,
                numImages: numberImages,
                prompt,
                referenceImages: input.referenceImages,
                seed: input.seed,
                threadId: context.threadId!,
                userId: context.userId!,
            });

            toolsLogger.debug(`[IMAGE_GEN] Generated ${result.assets.length} images`);

            return {
                images: result.assets.map((asset) => {
                    return {
                        model: result.modelId,
                        prompt: result.prompt,
                        url: asset.imageUrl,
                    };
                }),
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            toolsLogger.error(`[IMAGE_GEN] Generation failed: ${errorMessage}`);

            return {
                error: errorMessage,
                images: [],
            };
        }
    },
    inputSchema: z
        .object({
            aspectRatio: z
                .enum(["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "2:3", "3:2", "2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20", "21:9"])
                .optional()
                .default("1:1")
                .meta({ description: "Image aspect ratio" }),
            model: z.string().optional().default("fal:flux-dev").meta({ description: "AI model to use (e.g., fal:flux-dev, google/gemini-2.5-flash-image)" }),
            negativePrompt: z.string().optional().meta({ description: "What to avoid in the image" }),
            numImages: z.number().min(1).max(4).optional().default(1).meta({ description: "Number of images to generate (1-4)" }),
            prompt: z.string().min(1).max(2000).meta({ description: "Detailed image description" }),
            referenceImages: z.array(z.url()).max(4).optional().meta({
                description:
                    "Ordered list of reference image URLs for multi-ref-capable models (Nano-Banana, FLUX Redux, IP-Adapter, etc.). Per-model cap defined in MODEL_REGISTRY.maxReferenceImages.",
            }),
            seed: z.number().optional().meta({ description: "Random seed for reproducibility" }),
        })
        .strict(),
    title: "Image Generation",
});

export default imageGenerationTool;
