import z from "zod/v4";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";

/**
 * Update Document Tool
 * Updates an existing document/artifact's content within the current thread.
 */
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { toolsLogger } from "../../lib/logger";

const updateDocumentTool = createTool<
    {
        content: string;
        documentId: string;
        language?: string;
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
    description: `Update an existing document/artifact's content. Use this when the user asks you to edit, modify, update, or revise a previously created document.

Provide the full updated content - this replaces the entire document content. Do not provide partial content or diffs.
You can also update the title if needed.`,
    execute: async (context, input) => {
        const { content, documentId, language, title } = input;

        if (!context.threadId) {
            throw new Error("Cannot update document: no active thread");
        }

        if (!context.userId) {
            throw new Error("Cannot update document: no authenticated user");
        }

        // Verify ownership before allowing update — defends against LLM-supplied
        // documentId pointing at another user's document (IDOR).
        const existing = await context.runQuery(internal.agent.documents.getDocumentInternal, {
            documentId: documentId as Id<"documents">,
        });

        if (!existing) {
            throw new Error(`Document ${documentId} not found`);
        }

        if (existing.userId !== context.userId) {
            throw new Error("Cannot update document: not the owner");
        }

        if (existing.threadId && existing.threadId !== context.threadId) {
            throw new Error("Cannot update document: belongs to a different thread");
        }

        toolsLogger.debug(`[updateDocument] Updating document ${documentId}`);

        const document = await context.runMutation(internal.agent.documents.updateDocumentInternal, {
            callerThreadId: context.threadId,
            content,
            documentId: documentId as Id<"documents">,
            language,
            messageId: context.messageId,
            title,
        });

        toolsLogger.debug(`[updateDocument] Updated document ${document._id} to version ${document.version}`);

        return {
            documentId: document._id,
            kind: document.kind,
            title: document.title,
            version: document.version,
        };
    },
    inputSchema: z
        .object({
            content: z.string().meta({ description: "The complete updated content of the document" }),
            documentId: z.string().min(1).meta({ description: "The ID of the document to update (from a previous createDocument result)" }),
            language: z.string().optional().meta({ description: "Updated programming language for code documents" }),
            title: z.string().min(1).max(200).optional().meta({ description: "Optional new title for the document" }),
        })
        .strict(),
    title: "Update Document",
});

export default updateDocumentTool;
