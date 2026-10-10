import z from "zod/v4";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";

/**
 * Create Document Tool
 * Creates a new document/artifact (text, code, sheet, or image) within the current thread.
 */
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { toolsLogger } from "../../lib/logger";

const createDocumentTool = createTool<
    {
        content: string;
        kind: "text" | "code" | "sheet" | "image";
        language?: string;
        title: string;
    },
    {
        documentId: string;
        kind: string;
        title: string;
        version: number;
    },
    ToolContext
>({
    description: `Create a new document/artifact in the current conversation. Use this when the user asks you to create, write, or generate a document, code file, spreadsheet, or image.

Document kinds:
- "text": Markdown documents (articles, reports, notes, plans)
- "code": Source code files (specify language parameter)
- "sheet": CSV spreadsheet data
- "image": SVG or description for image generation

Always provide a descriptive title. For code documents, always specify the programming language.

Code documents in "html", "svg", "jsx" or "tsx" get a live preview. For a React component the user should see rendered, use language "jsx" or "tsx": ONE self-contained file whose default export (or a component named App) is the component to render. It may import only react, react-dom, lucide-react, recharts, framer-motion and clsx — no relative imports, no CSS files; style with Tailwind utility classes, which work in the preview.`,
    execute: async (context, input) => {
        const { content, kind, language, title } = input;

        if (!context.threadId) {
            throw new Error("Cannot create document: no active thread");
        }

        if (!context.userId) {
            throw new Error("Cannot create document: no authenticated user");
        }

        toolsLogger.debug(`[createDocument] Creating ${kind} document: "${title}"`);

        const document = await context.runMutation(internal.agent.documents.createDocument, {
            content,
            kind,
            language,
            messageId: context.messageId,
            threadId: context.threadId as Id<"threads">,
            title,
            userId: context.userId,
        });

        toolsLogger.debug(`[createDocument] Created document ${document._id}`);

        return {
            documentId: document._id,
            kind: document.kind,
            title: document.title,
            version: document.version,
        };
    },
    inputSchema: z
        .object({
            content: z.string().meta({ description: "The full content of the document. Use markdown for text, source code for code, CSV for sheets." }),
            kind: z.enum(["text", "code", "sheet", "image"]).meta({ description: "The type of document to create" }),
            language: z.string().optional().meta({
                description:
                    "Programming language for code documents (e.g., 'typescript', 'python', 'rust'; 'jsx'/'tsx' for a previewable React component). Required when kind is 'code'.",
            }),
            title: z.string().min(1).max(200).meta({ description: "A descriptive title for the document" }),
        })
        .strict(),
    title: "Create Document",
});

export default createDocumentTool;
