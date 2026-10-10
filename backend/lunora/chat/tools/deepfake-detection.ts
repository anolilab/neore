import type { LanguageModel } from "ai";

/**
 * Deepfake / Reality Detection Tool
 * Analyzes images for signs of AI generation or manipulation.
 * Uses the agent's language model via AI SDK generateText to detect artifacts,
 * inconsistencies, and manipulation indicators.
 */
import { generateText } from "ai";
import z from "zod/v4";

import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { toolsLogger } from "../../lib/logger";
import toonEncodeOutput from "./toon-encode";
import { formatError, isSafeUrl, withRetry } from "./utilities";

const DETECTION_PROMPT = `You are an expert forensic image analyst specializing in detecting AI-generated and manipulated images. Analyze this image for signs of AI generation or manipulation.

Examine the following indicators and provide your analysis:

1. **FACIAL ANALYSIS** (if faces present):
   - Skin texture consistency (AI often produces too-smooth or waxy skin)
   - Eye symmetry and reflection consistency
   - Hair rendering (strand detail, hairline naturalness)
   - Teeth regularity (AI tends to produce uniform teeth)
   - Ear symmetry and detail

2. **ARTIFACT DETECTION**:
   - Background consistency and coherence
   - Edge artifacts or blending issues
   - Repetitive patterns or textures
   - Unusual distortions around fingers, hands, or accessories
   - Text rendering quality (AI struggles with text)

3. **LIGHTING & PHYSICS**:
   - Consistent light source direction
   - Shadow accuracy and consistency
   - Reflection accuracy (mirrors, glasses, water)
   - Physical plausibility of objects and proportions

4. **METADATA & TECHNICAL**:
   - Compression artifact patterns
   - Noise distribution consistency
   - Resolution uniformity across the image

5. **OVERALL ASSESSMENT**:
   - Confidence score (0-100): 0 = definitely authentic, 100 = definitely AI-generated/manipulated
   - Classification: "likely_authentic", "uncertain", "likely_ai_generated", or "likely_manipulated"
   - Key reasons for your assessment
   - Specific areas of concern (if any)

Be thorough but honest — acknowledge uncertainty when indicators are ambiguous.`;

/**
 * Analyze image for deepfake/manipulation indicators using the agent's language model.
 */
const analyzeForDeepfake = async (context: ToolContext, imageUrl: string): Promise<string> => {
    if (!context.agent) {
        throw new Error("Agent not initialized — cannot access language model");
    }

    const result = await generateText({
        maxOutputTokens: 2500,
        messages: [
            {
                content: [
                    { text: DETECTION_PROMPT, type: "text" },
                    { image: new URL(imageUrl), type: "image" },
                ],
                role: "user",
            },
        ],
        model: context.agent.options.languageModel as LanguageModel,
    });

    return result.text || "Analysis could not be completed";
};

/**
 * URL of the image to analyze for deepfake indicators.
 */
const deepfakeDetectionTool = createTool<
    {
        imageUrl: string;
    },
    {
        analysis: string;
        disclaimer: string;
        error?: string;
        imageUrl: string;
    },
    ToolContext
>({
    description: `Analyze an image for signs of AI generation or manipulation (deepfake detection).
Examines facial features, artifacts, lighting consistency, and technical indicators.
Returns a detailed analysis with confidence score and classification.
IMPORTANT: This is an AI-based analysis tool and should not be used as the sole basis for determining image authenticity. Results are probabilistic, not definitive.`,
    execute: async (context, input) => {
        const { imageUrl } = input;

        if (!context.userId) {
            return { analysis: "", disclaimer: "Authentication required.", error: "Authentication required", imageUrl };
        }

        if (!isSafeUrl(imageUrl)) {
            return { analysis: "", disclaimer: "Invalid URL provided.", error: "Invalid or unsafe image URL", imageUrl };
        }

        toolsLogger.debug(`[DEEPFAKE] Analyzing: ${imageUrl.slice(0, 50)}...`);

        try {
            const analysis = await withRetry(() => analyzeForDeepfake(context, imageUrl), { maxRetries: 1 });

            return {
                analysis,
                disclaimer:
                    "This analysis is AI-based and probabilistic. It should not be used as definitive proof of image authenticity or manipulation. Professional forensic analysis may be needed for conclusive results.",
                imageUrl,
            };
        } catch (error) {
            const errorMessage = formatError(error);

            toolsLogger.error(`[DEEPFAKE] Analysis failed: ${errorMessage}`);

            return {
                analysis: "",
                disclaimer: "Analysis could not be completed.",
                error: errorMessage,
                imageUrl,
            };
        }
    },
    inputSchema: z
        .object({
            imageUrl: z.url().meta({ description: "URL of the image to analyze for deepfake indicators" }),
        })
        .strict(),
    title: "Deepfake Detection",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});

export default deepfakeDetectionTool;
