import { enabledModelOf } from "@neore/ai/models";

/**
 * Whether choosing `model` in an existing thread is an agent switch (`chat.agent_switch`) rather than
 * a plain edit of the thread's model: a text thread that runs on its own model, and a registry text
 * model to move to. Anything else — a bot's chat, a group chat, a media thread, a custom endpoint —
 * keeps the old behaviour.
 */
export const canSwitchAgent = (thread: { botId?: string; groupChat?: unknown; mode?: string; multiChat?: boolean }, model: string): boolean =>
    (thread.mode === undefined || thread.mode === "text") &&
    !thread.botId &&
    !thread.groupChat &&
    !thread.multiChat &&
    enabledModelOf(model, { mode: "text" }) !== undefined;
