/**
 * A tap on one of a tool approval's phone actions. The server sends the alert with the `tool_approval` category and the
 * approval's ids (`backend/lunora/notifications/phone-delivery.ts`); this reads the tap and answers the approval. It holds
 * no device API, so it runs the same in a test.
 */

/** The category the server names on an approval alert. Must match `TOOL_APPROVAL_CATEGORY` on the backend. */
export const TOOL_APPROVAL_CATEGORY = "tool_approval";

export const APPROVE_ACTION = "approve";
export const DENY_ACTION = "deny";

export interface ApprovalAnswer {
    approvalId: string;
    decision: "approve" | "deny";
    threadId: string;
}

/** The part of a response this reads: the action tapped, and the alert's data. */
export interface NotificationTap {
    actionIdentifier: string;
    notification: { request: { content: { data?: unknown } } };
}

/** The decision an action names, or `undefined` for an action that does not answer an approval. */
const decisionOf = (action: string): ApprovalAnswer["decision"] | undefined => {
    if (action === APPROVE_ACTION) {
        return "approve";
    }

    return action === DENY_ACTION ? "deny" : undefined;
};

const stringField = (data: unknown, key: string): string | undefined => {
    if (typeof data !== "object" || data === null) {
        return undefined;
    }

    const value: unknown = Object.entries(data).find(([name]) => name === key)?.[1];

    return typeof value === "string" && value.length > 0 ? value : undefined;
};

/**
 * A thread id as the server issues it: a bounded run of URL-safe characters. Anything else in an alert's data is not one, so the tap
 * is declined before any write is made with it.
 */
const THREAD_ID_FORMAT = /^[\w-]{1,64}$/u;

export const isThreadId = (value: string): boolean => THREAD_ID_FORMAT.test(value);

/**
 * Answers the approval a tap on approve or deny names. Returns `false` for any other tap, including the default tap that
 * opens the app, and for an alert missing either id. The answer is made only for a tap with both ids present.
 */
export const answerApprovalFromTap = async (tap: NotificationTap, answer: (value: ApprovalAnswer) => Promise<void>): Promise<boolean> => {
    const decision = decisionOf(tap.actionIdentifier);
    const { data } = tap.notification.request.content;

    if (decision === undefined) {
        return false;
    }

    const approvalId = stringField(data, "approvalId");
    const threadId = stringField(data, "threadId");

    if (approvalId === undefined || threadId === undefined || !isThreadId(threadId)) {
        return false;
    }

    await answer({ approvalId, decision, threadId });

    return true;
};
