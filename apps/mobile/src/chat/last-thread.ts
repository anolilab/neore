/**
 * The chat an account last viewed on this device, and the setting that reopens it on launch. These rules are pure: the
 * stored text is read and written by `last-thread-store.ts`, so they test without the native store.
 */

/** A saved chat, tied to the account that viewed it, so another account on this device never opens it. */
export interface LastThread {
    threadId: string;
    userId: string;
}

const OFF = "off";
const ON = "on";

/** The reopen setting as stored text. Nothing stored is on: the default is to reopen the last chat. */
export const isReopenOn = (raw: string | null): boolean => raw !== OFF;

export const reopenValue = (isOn: boolean): string => {
    if (isOn) {
        return ON;
    }

    return OFF;
};

const isNonEmptyText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** The saved chat from its stored text. A damaged or incomplete value is no chat at all. */
export const parseLastThread = (raw: string | null): LastThread | undefined => {
    if (raw === null) {
        return undefined;
    }

    try {
        const value: unknown = JSON.parse(raw);

        if (
            typeof value === "object"
            && value !== null
            && "threadId" in value
            && "userId" in value
            && isNonEmptyText(value.threadId)
            && isNonEmptyText(value.userId)
        ) {
            return { threadId: value.threadId, userId: value.userId };
        }
    } catch {
        // A damaged value reads as no saved chat.
    }

    return undefined;
};

/** Whether the saved chat is `threadId`. */
export const isSavedThread = (saved: LastThread | undefined, threadId: string): boolean => saved?.threadId === threadId;

/** The chat to open on launch: the saved one when the setting is on and this account viewed it. Otherwise none. */
export const threadToReopen = ({ isOn, last, userId }: { isOn: boolean; last: LastThread | undefined; userId: string }): string | undefined => {
    if (!isOn || last === undefined || last.userId !== userId) {
        return undefined;
    }

    return last.threadId;
};
