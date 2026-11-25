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

/**
 * Whether the toast for `event` is on. Every value other than `false` (absent, `null`, `true`) keeps it. Settings that have not
 * loaded yet (`undefined`) show nothing: the person's choice is not known, and a toast they switched off must not appear.
 */
export const isChatToastOn = (settings: ChatToastSettings | null | undefined, event: ChatToastEvent): boolean => {
    if (settings === undefined) {
        return false;
    }

    return settings?.[SETTING_OF[event]] !== false;
};

/** The message fields the toasts read: its id, its parts, who wrote it, and its status (`error` when the reply failed on the server). */
export interface ToastMessage {
    id?: string;
    parts?: ReadonlyArray<unknown>;
    role?: string;
    status?: string;
}

/** The latest assistant reply, or `undefined` when there is none yet. */
const lastAssistantReply = (messages: ReadonlyArray<ToastMessage>): ToastMessage | undefined => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];

        if (message?.role === "assistant") {
            return message;
        }
    }

    return undefined;
};

/**
 * Whether the latest assistant reply ended in an error. A server-side failure ends the stream without a client error, so
 * the stream end alone cannot tell it from a finish.
 */
export const lastReplyFailed = (messages: ReadonlyArray<ToastMessage>): boolean => {
    const reply = lastAssistantReply(messages);

    return reply?.status === "error" || reply?.status === "failed";
};

/** Whether the latest assistant reply has stopped streaming. The stream can end before its reply is written to the thread. */
export const replySettled = (messages: ReadonlyArray<ToastMessage>): boolean => lastAssistantReply(messages)?.status !== "streaming";

/** A tool call that waits for the person, with the index and id of the message that holds it. */
export interface WaitingCall {
    index: number;
    messageId: string;
    toolCallId: string;
}

/**
 * The tool calls in `messages` that wait for the person's answer or approval (`approval-requested`). An `askUser` and a
 * secret request wait in the same state, so they count too.
 */
export const waitingCalls = (messages: ReadonlyArray<ToastMessage>): WaitingCall[] => {
    const calls: WaitingCall[] = [];

    messages.forEach((message, index) => {
        const parts = message.parts ?? [];

        for (const part of parts) {
            const waiting = typeof part === "object" && part !== null && "state" in part && part.state === "approval-requested";

            if (waiting && "toolCallId" in part && typeof part.toolCallId === "string") {
                calls.push({ index, messageId: message.id ?? `#${index}`, toolCallId: part.toolCallId });
            }
        }
    });

    return calls;
};

/** The ids of the tool calls that wait for the person, see {@link waitingCalls}. */
export const waitingApprovalIds = (messages: ReadonlyArray<ToastMessage>): string[] => waitingCalls(messages).map((call) => call.toolCallId);
