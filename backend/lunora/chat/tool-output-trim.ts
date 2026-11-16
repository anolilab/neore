import type { UIMessage } from "../agent/ui-messages";
import { isTrimmableToolOutput, type ToolOutputRef } from "./tool-output-policy";

/** Maps each tool call id to the id of the row that stores its result, so a trimmed output can be fetched back. */
export const toolResultRowIds = (rows: ReadonlyArray<{ _id: string; message?: unknown }>): Map<string, string> => {
    const ids = new Map<string, string>();

    for (const row of rows) {
        const content = (row.message as { content?: unknown } | null | undefined)?.content;

        if (!Array.isArray(content)) {
            continue;
        }

        for (const part of content as { toolCallId?: unknown; type?: unknown }[]) {
            if (part?.type === "tool-result" && typeof part.toolCallId === "string") {
                ids.set(part.toolCallId, row._id);
            }
        }
    }

    return ids;
};

/**
 * Leaves the output of each large, non-first-paint tool part out of the page. The part keeps its
 * state and gains an `outputRef`; the output is fetched on expand. A part with no known result row
 * keeps its output, so a trim never loses data it cannot fetch back.
 */
export const trimToolOutputs = (messages: UIMessage[], threadId: string, rowIdByToolCall: ReadonlyMap<string, string>): UIMessage[] =>
    messages.map((message) => {
        let changed = false;
        const parts = message.parts.map((part) => {
            const tool = part as { callProviderMetadata?: unknown; output?: unknown; state?: string; toolCallId?: string; type: string };
            const messageId = tool.toolCallId === undefined ? undefined : rowIdByToolCall.get(tool.toolCallId);

            if (messageId === undefined || tool.toolCallId === undefined || !isTrimmableToolOutput(tool, tool.output)) {
                return part;
            }

            changed = true;

            const ref: ToolOutputRef = { messageId, threadId, toolCallId: tool.toolCallId };

            return { ...tool, output: undefined, outputRef: ref } as unknown as typeof part;
        });

        return changed ? { ...message, parts } : message;
    });
