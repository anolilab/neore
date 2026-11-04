/**
 * What a running host turn is doing, read off its chunks for the live view: the agent's latest plan and its tool calls,
 * each tool at its latest report. Live only: none of it is kept on the saved reply (`reply.ts` reads text, children and
 * files), and a public viewer never gets it (`chat/streaming/index.ts#getStreamBody`). Pure, so the shape is pinned
 * without a database.
 */
import type { Doc } from "../../_generated/dataModel";

type ChunkEvent = NonNullable<Doc<"persistentChunks">["event"]>;
type PlanEvent = Extract<ChunkEvent, { kind: "plan" }>;
type ToolEvent = Extract<ChunkEvent, { kind: "tool" }>;

export interface HostActivityTool {
    exit?: ToolEvent["exit"];
    id: string;
    /** The tail of what the call printed, masked on the desktop. */
    output?: string;
    status: ToolEvent["status"];
    title: string;
    toolKind: string;
}

export interface HostActivity {
    /** The latest plan the turn received, whole; absent when the agent sent none. */
    plan?: PlanEvent["entries"];
    /** The turn's own tool calls in the order they started, the most recent {@link MAX_ACTIVITY_TOOLS}. */
    tools: HostActivityTool[];
}

/** The tool rows a live view gets: a long turn shows its latest calls, not every one it made. */
export const MAX_ACTIVITY_TOOLS = 50;

/** The activity in a turn's chunks, or undefined when it has neither a plan nor a tool call. */
export const hostActivityOf = (chunks: ReadonlyArray<Pick<Doc<"persistentChunks">, "event">>): HostActivity | undefined => {
    let plan: PlanEvent["entries"] | undefined;
    const tools = new Map<string, HostActivityTool>();

    for (const { event } of chunks) {
        if (event?.kind === "plan") {
            plan = event.entries;
        } else if (event?.kind === "tool") {
            // A later report of a call replaces the earlier one in place, so a row keeps its position.
            tools.set(event.id, {
                id: event.id,
                status: event.status,
                title: event.title,
                toolKind: event.toolKind,
                ...(event.output !== undefined && { output: event.output }),
                ...(event.exit !== undefined && { exit: event.exit }),
            });
        }
    }

    if (plan === undefined && tools.size === 0) {
        return undefined;
    }

    return { ...(plan !== undefined && { plan }), tools: [...tools.values()].slice(-MAX_ACTIVITY_TOOLS) };
};
