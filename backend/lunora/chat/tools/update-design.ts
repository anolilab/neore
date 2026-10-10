import z from "zod/v4";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";

/**
 * Update Design Tool
 * Modifies an existing design canvas by replacing its Fabric.js JSON content.
 * The AI provides the complete updated canvas JSON.
 */
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { toolsLogger } from "../../lib/logger";

const updateDesignTool = createTool<
    {
        canvasJson: Record<string, unknown>;
        documentId: string;
        title?: string;
    },
    {
        documentId: string;
        kind: string;
        title: string;
        version: number;
    },
    ToolContext
>({
    description: `Update an existing design canvas. Provide the complete updated Fabric.js canvas JSON.

The canvas JSON structure:
{
  "version": "6.6.1",
  "objects": [
    { "type": "IText", "text": "Hello", "left": 100, "top": 100, "fontSize": 32, "fill": "#000" },
    { "type": "Rect", "left": 0, "top": 0, "width": 200, "height": 100, "fill": "#4A90D9" },
    { "type": "Circle", "left": 300, "top": 300, "radius": 50, "fill": "#D94A4A" }
  ],
  "background": "#ffffff"
}

Object types: IText (text), Rect (rectangle), Circle, Line, Path (freehand).
Common properties: left, top, fill, stroke, strokeWidth, opacity, angle (rotation).
Text properties: text, fontSize, fontFamily, fontWeight, textAlign, fill.
Shape properties: width, height (Rect), radius (Circle), rx/ry (rounded corners).`,
    execute: async (context, input) => {
        const { canvasJson, documentId, title } = input;

        if (!context.threadId || !context.userId) {
            throw new Error("Cannot update design: no active thread or user");
        }

        // Verify ownership before mutating — defends against LLM-supplied
        // documentId pointing at another user's design (IDOR).
        const existing = await context.runQuery(internal.agent.documents.getDocumentInternal, {
            documentId: documentId as Id<"documents">,
        });

        if (!existing) {
            throw new Error(`Design ${documentId} not found`);
        }

        if (existing.userId !== context.userId) {
            throw new Error("Cannot update design: not the owner");
        }

        if (existing.threadId && existing.threadId !== context.threadId) {
            throw new Error("Cannot update design: belongs to a different thread");
        }

        toolsLogger.debug(`[updateDesign] Updating design ${documentId}`);

        const document = await context.runMutation(internal.agent.documents.updateDocumentInternal, {
            callerThreadId: context.threadId,
            contentJson: canvasJson,
            documentId: documentId as Id<"documents">,
            messageId: context.messageId,
            title,
        });

        toolsLogger.debug(`[updateDesign] Updated design ${document._id} to version ${document.version}`);

        return {
            documentId: document._id,
            kind: document.kind,
            title: document.title,
            version: document.version,
        };
    },
    inputSchema: z
        .object({
            canvasJson: z.record(z.string(), z.unknown()).meta({ description: "Complete Fabric.js canvas JSON with version, objects array, and background" }),
            documentId: z.string().min(1).meta({ description: "The ID of the design document to update" }),
            title: z.string().min(1).max(200).optional().meta({ description: "Optional new title for the design" }),
        })
        .strict(),
    title: "Update Design",
});

export default updateDesignTool;
