/**
 * What the chat knows of the MCP tool calls that are running right now: the newest report per
 * call, from the stream's `toolProgress` chunks (`stream-line.ts`). Not stored anywhere — a call
 * leaves when its `ended` marker arrives, and the whole set when the reply restarts.
 */
import type { ToolProgressEvent } from "./stream-line";
import { readToolProgress } from "./stream-line";

export interface ToolProgressEntry {
    message?: string;
    progress: number;
    serverName: string;
    toolCallId: string;
    toolName: string;
    total?: number;
}

/** Running calls in the order they first reported. */
export type ToolProgressState = ReadonlyArray<ToolProgressEntry>;

export const NO_TOOL_PROGRESS: ToolProgressState = [];

/** `state` with `event` applied: the call's entry is replaced (latest wins, never merged), and an `ended` marker removes it. */
export const applyToolProgress = (state: ToolProgressState, event: ToolProgressEvent): ToolProgressState => {
    const index = state.findIndex((entry) => entry.toolCallId === event.toolCallId);

    if (event.ended || event.progress === undefined) {
        return index === -1 ? state : state.toSpliced(index, 1);
    }

    const entry: ToolProgressEntry = {
        ...(event.message && { message: event.message }),
        progress: event.progress,
        serverName: event.serverName,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...(event.total !== undefined && { total: event.total }),
    };

    return index === -1 ? [...state, entry] : state.with(index, entry);
};

/**
 * The running calls of a persisted stream body (`getStreamBody`'s `toolProgress`): what a viewer that lost the live
 * stream shows. Each entry is read like a relayed report, so an unusable one is skipped and the message is sanitised.
 */
export const toolProgressOfBody = (entries: unknown): ToolProgressState => {
    if (!Array.isArray(entries) || entries.length === 0) {
        return NO_TOOL_PROGRESS;
    }

    let state = NO_TOOL_PROGRESS;

    for (const entry of entries) {
        const event = readToolProgress(entry);

        if (event) {
            state = applyToolProgress(state, event);
        }
    }

    return state;
};

/**
 * How far along the call is, 0 to 1, or `undefined` when the server gave no usable total
 * (the bar is then indeterminate). Progress past the total reads as complete.
 */
export const progressFraction = ({ progress, total }: Pick<ToolProgressEntry, "progress" | "total">): number | undefined => {
    if (total === undefined || total <= 0 || Number.isNaN(total)) {
        return undefined;
    }

    return Math.min(1, Math.max(0, progress / total));
};
