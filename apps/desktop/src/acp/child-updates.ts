/**
 * What an agent's `session/update` says about its children (plans/acp-agent-host.md §4.7), as the ledger takes it
 * (`children.ts`). Pure, so the session and the buffer measurement (`child-buffer.ts`) read the same wire the same way.
 */
import type { ChildInput } from "./children";
import type { ToolStatus } from "./types";

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const text = (value: unknown): string => typeof value === "string" ? value : "";

/** The text of a content block; anything that is not text shows as its type, in brackets. */
export const contentText = (content: unknown): string => {
    if (!isRecord(content)) {
        return "";
    }

    return content.type === "text" ? text(content.text) : `[${text(content.type) || "content"}]`;
};

/** A tool call's id as the host and its children's ledger key it: the parent stamp is cut to this, so the spawn card must be too. */
export const toolIdOf = (value: unknown): string => text(value).slice(0, 128);

const TOOL_STATUSES = new Set<ToolStatus>(["completed", "failed", "in_progress", "pending"]);

/**
 * The tool call a child's update belongs to. The adapter this was checked against (Claude Code's, 0.98.0) stamps
 * every update a child sends with `_meta.claudeCode.parentToolUseId`; an update with no stamp belongs to the agent.
 */
export const childParentOf = (update: Record<string, unknown>): string | undefined => {
    // eslint-disable-next-line no-underscore-dangle -- `_meta` is the protocol's own extension field
    const meta = isRecord(update._meta) ? update._meta : {};
    const stamp = isRecord(meta.claudeCode) ? meta.claudeCode.parentToolUseId : undefined;

    return typeof stamp === "string" && stamp !== "" ? toolIdOf(stamp) : undefined;
};

/** The text a tool call's content carries: what a spawn call says when its child is done. */
export const completionText = (content: unknown): string => {
    if (!Array.isArray(content)) {
        return "";
    }

    return content
        .map((entry: unknown) => isRecord(entry) && entry.type === "content" ? contentText(entry.content) : "")
        .filter((piece) => piece !== "")
        .join("\n");
};

/** A child's update as a ledger event; `undefined` for an update kind a child's transcript has no place for. */
export const childEventOf = (update: Record<string, unknown>, scrub: (value: string) => string): ChildInput | undefined => {
    switch (update.sessionUpdate) {
        case "agent_message_chunk": {
            return { kind: "text", text: contentText(update.content) };
        }
        case "agent_thought_chunk": {
            return { kind: "reasoning", text: contentText(update.content) };
        }
        case "tool_call":
        case "tool_call_update": {
            const id = toolIdOf(update.toolCallId);

            if (id === "") {
                return undefined;
            }

            // Only what the update says: a partial one must not reset the call's status or title to defaults.
            const title = text(update.title);
            const toolKind = text(update.kind);

            return {
                id,
                kind: "tool",
                ...TOOL_STATUSES.has(update.status as ToolStatus) && { status: update.status as string },
                ...title !== "" && { title: scrub(title).slice(0, 500) },
                ...toolKind !== "" && { toolKind: toolKind.slice(0, 64) },
            };
        }
        default: {
            return undefined;
        }
    }
};
