import type { JSONValue } from "@ai-sdk/provider";
import z from "zod/v4";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";

/**
 * Create Design Tool
 * Creates a new design canvas artifact with a Fabric.js JSON structure.
 * Supports platform presets (37 standard sizes) and design styles (16 styles).
 */
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { toolsLogger } from "../../lib/logger";

/** Build initial Fabric.js canvas JSON with optional background and elements. */
const buildInitialCanvasJson = (options: {
    backgroundColor: string;
    elements?: {
        properties: Record<string, unknown>;
        type: "text" | "rect" | "circle";
    }[];
    height: number;
    width: number;
}): Record<string, JSONValue> => {
    const objects: Record<string, JSONValue>[] = [];

    if (options.elements) {
        for (const element of options.elements) {
            // The tool's input schema is `z.record(z.string(), z.unknown())`, so the
            // values arrive as `unknown`. They are model-supplied JSON, and each read
            // below narrows to the property's expected primitive.
            const properties = element.properties as Record<string, JSONValue>;

            switch (element.type) {
                case "circle": {
                    objects.push({
                        fill: (properties.fill as string) ?? "#D94A4A",
                        left: (properties.left as number) ?? options.width / 2 - 50,
                        radius: (properties.radius as number) ?? 50,
                        top: (properties.top as number) ?? options.height / 2 - 50,
                        type: "Circle",
                        ...properties,
                    });
                    break;
                }
                case "rect": {
                    objects.push({
                        fill: (properties.fill as string) ?? "#4A90D9",
                        height: (properties.height as number) ?? 100,
                        left: (properties.left as number) ?? 0,
                        rx: (properties.rx as number) ?? 0,
                        ry: (properties.ry as number) ?? 0,
                        top: (properties.top as number) ?? 0,
                        type: "Rect",
                        width: (properties.width as number) ?? 200,
                        ...properties,
                    });
                    break;
                }
                case "text": {
                    objects.push({
                        fill: (properties.fill as string) ?? "#000000",
                        fontFamily: (properties.fontFamily as string) ?? "Inter, sans-serif",
                        fontSize: (properties.fontSize as number) ?? 32,
                        left: (properties.left as number) ?? options.width / 2 - 100,
                        text: (properties.text as string) ?? "Edit me",
                        textAlign: (properties.textAlign as string) ?? "center",
                        top: (properties.top as number) ?? options.height / 2 - 20,
                        type: "IText",
                        ...properties,
                    });
                    break;
                }
                default: {
                    break;
                }
            }
        }
    }

    return {
        background: options.backgroundColor,
        objects,
        version: "6.6.1",
    };
};

/** Preset dimensions lookup (subset — full list in `@neore/ai/design`). */
const PRESET_DIMENSIONS: Record<string, { height: number; width: number }> = {
    "app-icon": { height: 1024, width: 1024 },
    "blog-header": { height: 630, width: 1200 },
    "business-card": { height: 600, width: 1050 },
    "custom-landscape": { height: 1080, width: 1920 },
    "custom-portrait": { height: 1920, width: 1080 },
    "custom-square": { height: 1080, width: 1080 },
    "email-header": { height: 200, width: 600 },
    "email-hero": { height: 400, width: 600 },
    favicon: { height: 512, width: 512 },
    "fb-cover": { height: 312, width: 820 },
    "fb-post": { height: 630, width: 1200 },
    "ig-landscape": { height: 566, width: 1080 },
    "ig-post": { height: 1080, width: 1080 },
    "ig-story": { height: 1920, width: 1080 },
    "linkedin-cover": { height: 396, width: 1584 },
    "linkedin-post": { height: 627, width: 1200 },
    "og-image": { height: 630, width: 1200 },
    "pinterest-pin": { height: 1500, width: 1000 },
    "tiktok-video": { height: 1920, width: 1080 },
    "web-banner": { height: 480, width: 1920 },
    "web-hero": { height: 1080, width: 1920 },
    "x-header": { height: 500, width: 1500 },
    "x-post": { height: 675, width: 1200 },
    "youtube-banner": { height: 1440, width: 2560 },
    "youtube-thumb": { height: 720, width: 1280 },
};

const createDesignTool = createTool<
    {
        backgroundColor?: string;
        elements?: {
            properties: Record<string, unknown>;
            type: "text" | "rect" | "circle";
        }[];
        height?: number;
        presetId?: string;
        title: string;
        width?: number;
    },
    {
        documentId: string;
        height: number;
        kind: string;
        title: string;
        version: number;
        width: number;
    },
    ToolContext
>({
    description: `Create a new design canvas for visual content like social media posts, marketing graphics, banners, or any visual composition.

This creates an interactive Fabric.js canvas that the user can edit visually. Use this instead of createDocument with kind="image" when the user wants to create a design they can interactively edit.

Available presets (standard sizes):
- Social: ig-post (1080×1080), ig-story (1080×1920), fb-post (1200×630), x-post (1200×675), linkedin-post (1200×627), youtube-thumb (1280×720), pinterest-pin (1000×1500), tiktok-video (1080×1920)
- Marketing: og-image (1200×630), blog-header (1200×630), email-header (600×200), business-card (1050×600)
- Web: web-hero (1920×1080), web-banner (1920×480), favicon (512×512), app-icon (1024×1024)
- Custom: custom-square (1080×1080), custom-landscape (1920×1080), custom-portrait (1080×1920)

You can also specify custom width/height instead of a preset.

Elements can be pre-positioned on the canvas:
- "text": Text with properties like text, fontSize, fontFamily, fill, left, top, textAlign
- "rect": Rectangle with width, height, fill, left, top, rx, ry
- "circle": Circle with radius, fill, left, top

Design tips: Use the rule of thirds for element placement. Ensure text contrast against backgrounds. Keep designs clean and focused.`,
    execute: async (context, input) => {
        const { backgroundColor = "#ffffff", elements, presetId, title } = input;

        if (!context.threadId) {
            throw new Error("Cannot create design: no active thread");
        }

        if (!context.userId) {
            throw new Error("Cannot create design: no authenticated user");
        }

        // Resolve dimensions from preset or custom values
        let width = input.width ?? 1080;
        let height = input.height ?? 1080;

        if (presetId && PRESET_DIMENSIONS[presetId]) {
            const preset = PRESET_DIMENSIONS[presetId];

            width = preset.width;
            height = preset.height;
        }

        toolsLogger.debug(`[createDesign] Creating design "${title}" (${width}×${height})`);

        // Build initial Fabric.js JSON
        const canvasJson = buildInitialCanvasJson({
            backgroundColor,
            elements,
            height,
            width,
        });

        // Create document with kind: "design"
        const document = await context.runMutation(internal.agent.documents.createDocument, {
            content: "", // Will be updated with PNG preview when user edits
            contentJson: canvasJson,
            kind: "design",
            messageId: context.messageId,
            threadId: context.threadId as Id<"threads">,
            title,
            userId: context.userId,
        });

        toolsLogger.debug(`[createDesign] Created design document ${document._id}`);

        return {
            documentId: document._id,
            height,
            kind: "design",
            title: document.title,
            version: document.version,
            width,
        };
    },
    inputSchema: z
        .object({
            backgroundColor: z.string().optional().default("#ffffff").meta({ description: "Background color as hex string (e.g., '#ffffff', '#1a1a2e')" }),
            elements: z
                .array(
                    z.object({
                        properties: z.record(z.string(), z.unknown()).meta({ description: "Element properties (position, style, content)" }),
                        type: z.enum(["text", "rect", "circle"]).meta({ description: "Element type" }),
                    }),
                )
                .optional()
                .meta({ description: "Initial canvas elements to place on the design" }),
            height: z.number().min(50).max(8000).optional().meta({ description: "Custom canvas height in pixels. Ignored if presetId is provided." }),
            presetId: z.string().optional().meta({ description: "Platform preset ID for standard dimensions (e.g., 'ig-post', 'youtube-thumb')" }),
            title: z.string().min(1).max(200).meta({ description: "A descriptive title for the design" }),
            width: z.number().min(50).max(8000).optional().meta({ description: "Custom canvas width in pixels. Ignored if presetId is provided." }),
        })
        .strict(),
    title: "Create Design",
});

export default createDesignTool;
