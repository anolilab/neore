import type { LanguageModel } from "ai";

/**
 * Vision / Image Analysis Tool
 * Analyzes images using the agent's language model via AI SDK generateText.
 * Supports OCR, object detection, scene understanding, and detailed description.
 */
import { generateText } from "ai";
import z from "zod/v4";

import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { toolsLogger } from "../../lib/logger";
import toonEncodeOutput from "./toon-encode";
import { formatError, isSafeUrl, withRetry } from "./utilities";

type AnalysisType = "describe" | "ocr" | "objects" | "scene" | "detailed";

const analysisPrompts: Record<AnalysisType, string> = {
    describe: "Describe this image in detail. Include colors, composition, subjects, mood, and any notable elements.",
    detailed: `Provide a comprehensive analysis of this image covering:
1. DESCRIPTION: What is shown in the image
2. TEXT/OCR: Any text visible in the image
3. OBJECTS: Key objects and their positions
4. COLORS: Dominant colors and color palette
5. COMPOSITION: Layout, framing, perspective
6. TECHNICAL: Image quality, resolution assessment, any artifacts
7. CONTEXT: Likely context, purpose, or origin of the image`,
    objects:
        "List all objects, entities, and elements visible in this image. For each, provide: name, approximate position (top-left, center, bottom-right, etc.), size (small/medium/large relative to image), and confidence level.",
    ocr: "Extract ALL text visible in this image. Preserve the original formatting, layout, and structure as much as possible. Include any headers, labels, captions, watermarks, or small text.",
    scene: "Analyze this image as a scene. Describe: 1) Setting/environment 2) Lighting conditions 3) Time of day (if applicable) 4) Weather (if outdoor) 5) Mood/atmosphere 6) Key activities happening 7) Any text or signage visible.",
};

/**
 * Analyze an image using the agent's language model via AI SDK.
 */
const analyzeWithVisionModel = async (context: ToolContext, imageUrl: string, analysisType: AnalysisType, customPrompt?: string): Promise<string> => {
    if (!context.agent) {
        throw new Error("Agent not initialized — cannot access language model");
    }

    const prompt = customPrompt || analysisPrompts[analysisType];

    const result = await generateText({
        maxOutputTokens: 2000,
        messages: [
            {
                content: [
                    { text: prompt, type: "text" },
                    { image: new URL(imageUrl), type: "image" },
                ],
                role: "user",
            },
        ],
        model: context.agent.options.languageModel as LanguageModel,
    });

    return result.text || "No analysis produced";
};

/**
 * Vision / Image Analysis Tool
 */
const visionAnalysisTool = createTool<
    {
        analysisType?: AnalysisType;
        customPrompt?: string;
        imageUrl: string;
    },
    {
        analysis: string;
        analysisType: string;
        error?: string;
        imageUrl: string;
    },
    ToolContext
>({
    description: `Analyze images using AI vision. Supports multiple analysis types:
- describe: General image description (colors, composition, subjects)
- ocr: Extract all text from the image with formatting preserved
- objects: Detect and list all objects with positions and sizes
- scene: Understand the scene (setting, lighting, mood, activities)
- detailed: Comprehensive analysis covering all aspects
You can also provide a custom prompt for specific analysis needs.`,
    execute: async (context, input) => {
        const { analysisType = "describe", customPrompt, imageUrl } = input;

        if (!context.userId) {
            return { analysis: "", analysisType, error: "Authentication required", imageUrl };
        }

        if (!isSafeUrl(imageUrl)) {
            return { analysis: "", analysisType, error: "Invalid or unsafe image URL", imageUrl };
        }

        toolsLogger.debug(`[VISION] Analyzing image (${analysisType}): ${imageUrl.slice(0, 50)}...`);

        try {
            const analysis = await withRetry(() => analyzeWithVisionModel(context, imageUrl, analysisType, customPrompt), { maxRetries: 1 });

            return {
                analysis,
                analysisType,
                imageUrl,
            };
        } catch (error) {
            const errorMessage = formatError(error);

            toolsLogger.error(`[VISION] Analysis failed: ${errorMessage}`);

            return {
                analysis: "",
                analysisType,
                error: errorMessage,
                imageUrl,
            };
        }
    },
    inputSchema: z
        .object({
            analysisType: z
                .enum(["describe", "ocr", "objects", "scene", "detailed"])
                .optional()
                .default("describe")
                .meta({ description: "Type of analysis to perform (default: describe)" }),
            customPrompt: z.string().max(1000).optional().meta({ description: "Custom analysis prompt (overrides analysisType)" }),
            imageUrl: z.url().meta({ description: "URL of the image to analyze" }),
        })
        .strict(),
    title: "Vision Analysis",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});

export default visionAnalysisTool;
