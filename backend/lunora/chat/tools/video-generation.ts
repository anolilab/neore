import z from "zod/v4";

import { internal } from "../../_generated/internal";

/**
 * Video Generation Tool
 * Generates short videos from text descriptions using FAL.ai Mochi v1
 */
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { toolsLogger } from "../../lib/logger";
import { checkRateLimit } from "../../lib/rate-limiter";

const videoGenerationTool = createTool<
    {
        aspectRatio?: string;
        duration?: number;
        model?: string;
        prompt: string;
        startFrameUrl?: string;
    },
    {
        error?: string;
        prompt: string;
        videoUrl: string;
    },
    ToolContext
>({
    description: `Generate short videos from text descriptions (text-to-video) or animate a still image (image-to-video).
Supports durations: 1-10 seconds.
Aspect ratios: auto, 1:1, 16:9, 9:16, 4:3, 3:4, 2:1, 21:9, 9:20.

Modes:
- Text-to-video: omit startFrameUrl. Default model: fal-ai/mochi-v1. Frontier options: fal-ai/veo3, fal-ai/veo3/fast, fal-ai/veo2.
- Image-to-video: pass a publicly reachable startFrameUrl and pick an I2V model (e.g. fal-ai/veo3/image-to-video, fal-ai/veo3/fast/image-to-video, fal-ai/veo2/image-to-video, fal-ai/kling-video/v1.5/pro/image-to-video, fal-ai/bytedance/seedance/v1.5/pro/image-to-video, fal-ai/luma-dream-machine/image-to-video, fal-ai/minimax/video-01-live/image-to-video).

Note: Video generation takes 60-120 seconds to complete.`,
    execute: async (context, input) => {
        const { aspectRatio = "16:9", duration = 5, model = "fal-ai/mochi-v1", prompt, startFrameUrl } = input;

        if (!context.userId) {
            return { error: "Authentication required", prompt, videoUrl: "" };
        }

        // Charge the daily video bucket (same as the chat http path) so the
        // tool cannot be invoked in a loop to bypass the per-day cap.
        const tier = context.userTier === "premium" || context.userTier === "ultra" ? "premium" : "free";
        const limited = await checkRateLimit(context, `chat/dailyVideo:${tier}`, {
            count: 1,
            key: context.userId,
            throws: false,
        });

        if (!limited.ok) {
            return { error: "Daily video generation limit reached", prompt, videoUrl: "" };
        }

        toolsLogger.debug(`[VIDEO_GEN] Generating ${duration}s video: ${prompt.slice(0, 50)}...`);

        try {
            // Call internal action to handle generation
            const result = await context.runAction(internal.chat.functions.generateVideo, {
                aspectRatio,
                duration,
                model,
                prompt,
                startFrameUrl,
                threadId: context.threadId!,
                userId: context.userId!,
            });

            toolsLogger.debug(`[VIDEO_GEN] Generated video`);

            return {
                prompt: result.prompt,
                videoUrl: result.assets[0]?.videoUrl || "",
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            toolsLogger.error(`[VIDEO_GEN] Generation failed: ${errorMessage}`);

            return {
                error: errorMessage,
                prompt,
                videoUrl: "",
            };
        }
    },
    inputSchema: z
        .object({
            aspectRatio: z
                .enum(["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "2:1", "21:9", "9:20"])
                .optional()
                .default("16:9")
                .meta({ description: "Video aspect ratio (ignored for image-to-video models that infer aspect from the source image)" }),
            duration: z.number().min(1).max(10).optional().default(5).meta({ description: "Video duration in seconds" }),
            model: z.string().optional().default("fal-ai/mochi-v1").meta({ description: "AI model id from the registry" }),
            prompt: z.string().min(1).max(500).meta({ description: "Video scene description (optional context when animating an image)" }),
            startFrameUrl: z
                .url()
                .optional()
                .meta({ description: "Public URL of a still image to animate. When provided, an image-to-video model MUST be selected." }),
        })
        .strict(),
    title: "Video Generation",
});

export default videoGenerationTool;
