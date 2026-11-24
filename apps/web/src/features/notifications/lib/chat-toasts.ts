/**
 * The in-app toasts a chat run raises, and the settings that gate each one. A toast is shown unless its
 * setting is explicitly `false`: an absent setting (every account before the toggles existed) keeps the toast.
 */

/** A chat event that raises an in-app toast: the run failed, finished, or waits for the person's input or approval. */
export type ChatToastEvent = "failed" | "finished" | "input";

/** The `userSettings` columns that gate each toast (`backend/lunora/auth/fields.ts`). */
export interface ChatToastSettings {
    chatFailedToastEnabled?: boolean | null;
    chatFinishedToastEnabled?: boolean | null;
    chatInputToastEnabled?: boolean | null;
}

const SETTING_OF: Record<ChatToastEvent, keyof ChatToastSettings> = {
    failed: "chatFailedToastEnabled",
    finished: "chatFinishedToastEnabled",
    input: "chatInputToastEnabled",
};

/** Whether the toast for `event` is on: every value other than `false` (absent, `null`, `true`) keeps it. */
export const isChatToastOn = (settings: ChatToastSettings | null | undefined, event: ChatToastEvent): boolean => settings?.[SETTING_OF[event]] !== false;

/**
 * The tool calls in `messages` that wait for the person's answer or approval (`approval-requested`). An `askUser` and a
 * secret request wait in the same state, so they count too.
 */
export const waitingApprovalIds = (messages: ReadonlyArray<{ parts?: ReadonlyArray<unknown> }>): string[] => {
    const ids: string[] = [];

    for (const message of messages) {
        const parts = message.parts ?? [];

        for (const part of parts) {
            const waiting = typeof part === "object" && part !== null && "state" in part && part.state === "approval-requested";

            if (waiting && "toolCallId" in part && typeof part.toolCallId === "string") {
                ids.push(part.toolCallId);
            }
        }
    }

    return ids;
};
