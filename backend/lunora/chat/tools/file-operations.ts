import z from "zod/v4";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";

/**
 * File Operations Tool
 *
 * Create, read, edit, delete, and list files in the persistent E2B sandbox.
 * Uses the str_replace pattern for edits (exact match required).
 * Follows the browserTool pattern with action enum.
 */
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { toolsLogger } from "../../lib/logger";
import type { FileOperationResult } from "./sandbox-node";

// `FileOperationResult` now lives with the action that produces it — a second
// declaration here is a copy that can drift from what actually comes back.

/**
 * The file operation to perform.
 */
const fileOperationsTool = createTool<
    {
        action: "create_file" | "read_file" | "edit_file" | "delete_file" | "list_directory";
        content?: string;
        endLine?: number;
        newString?: string;
        oldString?: string;
        path: string;
        startLine?: number;
    },
    FileOperationResult,
    ToolContext
>({
    description: `Manage files in the persistent sandbox filesystem.
Available actions:
- **create_file**: Create or overwrite a file. Requires \`path\` and \`content\`.
- **read_file**: Read file content. Requires \`path\`. Optional \`startLine\`/\`endLine\` for partial reads.
- **edit_file**: Edit a file using find-and-replace. Requires \`path\`, \`oldString\`, and \`newString\`. The old string must match exactly once in the file.
- **delete_file**: Delete a file. Requires \`path\`.
- **list_directory**: List directory contents. Requires \`path\`.

All paths are relative to /home/user or can be absolute (within /home/user or /tmp).
Files persist across calls within the same conversation.`,
    execute: async (context, input) => {
        const { action, path } = input;

        toolsLogger.debug(`[FILE_OPS] ${action}: ${path}`);

        if (!context.userId) {
            return { error: "Authentication required for file operations", success: false };
        }

        if (!context.threadId) {
            return { error: "Thread context required for file operations", success: false };
        }

        // Map action to operation
        const operationMap: Record<string, string> = {
            create_file: "create",
            delete_file: "delete",
            edit_file: "edit",
            list_directory: "list",
            read_file: "read",
        };

        try {
            const result = await context.runAction(internal.chat.tools.sandbox_node.executeFileOperation, {
                content: input.content,
                endLine: input.endLine,
                newString: input.newString,
                oldString: input.oldString,
                operation: operationMap[action]!,
                path,
                startLine: input.startLine,
                threadId: context.threadId as Id<"threads">,
                userId: context.userId,
            });

            toolsLogger.debug(`[FILE_OPS] ${action} ${result.success ? "succeeded" : "failed"}`);

            return result;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            toolsLogger.error(`[FILE_OPS] ${action} failed: ${errorMessage}`);

            return {
                error: errorMessage,
                path,
                success: false,
            };
        }
    },
    inputSchema: z
        .object({
            action: z.enum(["create_file", "read_file", "edit_file", "delete_file", "list_directory"]).meta({ description: "The file operation to perform" }),
            content: z.string().optional().meta({ description: "File content (required for create_file)" }),
            endLine: z.int().min(1).optional().meta({ description: "End line for partial read (inclusive)" }),
            newString: z.string().optional().meta({ description: "Replacement string (required for edit_file)" }),
            oldString: z.string().optional().meta({ description: "String to find (required for edit_file, must match exactly once)" }),
            path: z.string().min(1).max(4096).meta({ description: "File or directory path" }),
            startLine: z.int().min(1).optional().meta({ description: "Start line for partial read (1-indexed)" }),
        })
        .strict(),
    title: "File Operations",
});

export default fileOperationsTool;
