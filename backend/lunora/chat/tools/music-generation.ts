import z from "zod/v4";

import { internal } from "../../_generated/internal";

/**
 * Music Generation Tool
 *
 * Generates short music clips from text descriptions via FAL music endpoints.
 * Backed by the `generateMusic` internal action, which calls FAL's queue API
 * and persists the rendered audio as a file part on the assistant message.
 */
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { toolsLogger } from "../../lib/logger";
import { checkRateLimit } from "../../lib/rate-limiter";

const musicGenerationTool = createTool<
    {
        duration?: number;
        model?: string;
        negativePrompt?: string;
        prompt: string;
    },
    {
        audioUrl: string;
        error?: string;
        prompt: string;
    },
    ToolContext
>({
    description: `Generate short music clips from a text description.

Models:
- fal-ai/stable-audio-25 (default) — high-quality music + sound effects, up to 190s, $0.20/clip.
- fal-ai/musicgen — Meta MusicGen, up to 60s, fastest of the set.
- fal-ai/lyria2 — Google Lyria 2, fixed 30s clips, lush instrumental music, supports negative_prompt.
- fal-ai/cassetteai-music-generator — CassetteAI, up to 60s, song-like output with lyrics-friendly prompts.

Typical generation time: 10–30 seconds.`,
    execute: async (context, input) => {
        const { duration, model = "fal-ai/stable-audio-25", negativePrompt, prompt } = input;

        if (!context.userId) {
            return { audioUrl: "", error: "Authentication required", prompt };
        }

        const tier = context.userTier === "premium" || context.userTier === "ultra" ? "premium" : "free";
        const limited = await checkRateLimit(context, `chat/dailyMusic:${tier}`, {
            count: 1,
            key: context.userId,
            throws: false,
        });

        if (!limited.ok) {
            return { audioUrl: "", error: "Daily music generation limit reached", prompt };
        }

        toolsLogger.debug(`[MUSIC_GEN] Generating ${duration ?? "default"}s music: ${prompt.slice(0, 50)}...`);

        try {
            const result = await context.runAction(internal.chat.functions.generateMusic, {
                duration,
                model,
                negativePrompt,
                prompt,
                threadId: context.threadId!,
                userId: context.userId!,
            });

            toolsLogger.debug("[MUSIC_GEN] Generated music clip");

            return {
                audioUrl: result.assets[0]?.audioUrl || "",
                prompt: result.prompt,
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            toolsLogger.error(`[MUSIC_GEN] Generation failed: ${errorMessage}`);

            return {
                audioUrl: "",
                error: errorMessage,
                prompt,
            };
        }
    },
    inputSchema: z
        .object({
            duration: z
                .number()
                .min(1)
                .max(190)
                .optional()
                .meta({ description: "Clip length in seconds. Ignored by models with a fixed clip length (e.g. lyria2 is always 30s)." }),
            model: z
                .enum(["fal-ai/stable-audio-25", "fal-ai/musicgen", "fal-ai/lyria2", "fal-ai/cassetteai-music-generator"])
                .optional()
                .default("fal-ai/stable-audio-25")
                .meta({ description: "Which music model to use." }),
            negativePrompt: z
                .string()
                .max(2000)
                .optional()
                .meta({ description: "What to avoid (e.g. 'vocals, distortion'). Only honoured by models that support it (lyria2)." }),
            prompt: z.string().min(1).max(2000).meta({ description: "Describe the music: genre, mood, instruments, tempo." }),
        })
        .strict(),
    title: "Music Generation",
});

export default musicGenerationTool;
