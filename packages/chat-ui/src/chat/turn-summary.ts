import type { MessagePart, ToolPart } from "../types/message";
import { resolveMcpToolName } from "../utils/mcp-tool-name";

export interface ToolGroupSegment {
    /** Index of the last part in the run (always a tool part). */
    end: number;
    kind: "group";
    /** Tool names with their call counts, most frequent first (ties keep first-seen order). */
    names: { count: number; name: string }[];
    /** Index of the first part in the run (always a tool part). */
    start: number;
    toolCount: number;
}

export interface PartSegment {
    index: number;
    kind: "part";
}

export type TurnSegment = PartSegment | ToolGroupSegment;

const isToolPart = (part: MessagePart): part is ToolPart => (part.type as string).startsWith("tool-");

export const toolDisplayName = (part: Pick<ToolPart, "callProviderMetadata" | "type">): string =>
    resolveMcpToolName(part)?.toolName ?? part.type.replace("tool-", "");

/**
 * Walks a finished message's parts and folds each run of 2+ consecutive completed tool calls
 * (reasoning between them included) into one group. Anything else, and any call that is
 * pending, awaiting approval, failed, or rejected by `canFold`, stays a plain part.
 */
export const segmentTurn = (parts: ReadonlyArray<MessagePart>, canFold: (part: ToolPart) => boolean = () => true): TurnSegment[] => {
    const segments: TurnSegment[] = [];
    // Tool calls of the open run, and the reasoning / step markers seen since the last of them.
    let tools: number[] = [];
    let between: number[] = [];

    const plain = (indexes: number[]) => {
        for (const index of indexes) {
            segments.push({ index, kind: "part" });
        }
    };

    const flush = () => {
        if (tools.length >= 2) {
            const counts = new Map<string, number>();

            for (const index of tools) {
                const name = toolDisplayName(parts[index] as ToolPart);

                counts.set(name, (counts.get(name) ?? 0) + 1);
            }

            // toSorted is stable, so ties keep first-seen order.
            const names = [...counts]
                .map(([name, count]) => {
                    return { count, name };
                })
                .toSorted((a, b) => b.count - a.count);

            segments.push({ end: tools.at(-1) as number, kind: "group", names, start: tools[0] as number, toolCount: tools.length });
        } else {
            plain(tools);
        }

        plain(between);

        tools = [];
        between = [];
    };

    for (const [index, part] of parts.entries()) {
        if (isToolPart(part) && part.state === "output-available" && canFold(part)) {
            // Anything buffered since the last call sits inside the run, so it is covered by the group's range.
            between = [];
            tools.push(index);
        } else if ((part.type === "reasoning" || part.type === "step-start") && tools.length > 0) {
            between.push(index);
        } else {
            flush();
            segments.push({ index, kind: "part" });
        }
    }

    flush();

    return segments;
};
