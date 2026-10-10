/**
 * Stamps a run's saved MCP tool calls with their real server and tool names —
 * see `lib/mcp-tool-labels.ts`. Called from `finishRun` once the run's messages
 * are saved.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { patchMessage } from "../agent/table-writes";
import { labelMcpToolCalls } from "./lib/mcp-tool-labels";

export const labelToolCalls = internalMutation
    .input({
        labels: v.record(v.string(), v.object({ serverName: v.string(), toolName: v.string() })),
        messageIds: v.array(v.string()),
        userId: v.string(),
    })
    .output(v.null())
    .mutation(async ({ args: { labels, messageIds, userId }, ctx }) => {
        const uniqueIds = new Set(messageIds);

        for (const messageId of uniqueIds) {
            const doc = await ctx.db.get(messageId as Id<"messages">);

            if (!doc || doc.userId !== userId || (doc.message as { role?: string } | undefined)?.role !== "assistant") {
                continue;
            }

            const message = doc.message as { content?: unknown };
            const content = labelMcpToolCalls(message.content, labels);

            if (content) {
                await patchMessage(ctx.db, doc._id, { message: { ...message, content } });
            }
        }

        return null;
    });
