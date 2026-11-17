import type { PendingAttachment } from "../core/stores/chat-ui-store";

/** A send pressed while uploads run: the attachments it waits for, and the chat it was pressed in. */
export interface UploadWait {
    attachmentIds: ReadonlyArray<string>;
    threadId: string | undefined;
}

export type UploadWaitOutcome = { kind: "cancelled" } | { kind: "failed"; name: string } | { kind: "send" } | { kind: "waiting" };

type WaitedAttachment = Pick<PendingAttachment, "id" | "name" | "status">;

/**
 * What a waiting send does now that its attachments changed. It goes out only once every waited upload has completed.
 * A failed upload stops it, and the user removes that file to send. A removed file or a chat change cancels it: the
 * draft on screen is no longer the one the user sent.
 */
export const settleUploadWait = (wait: UploadWait, attachments: ReadonlyArray<WaitedAttachment>, threadId: string | undefined): UploadWaitOutcome => {
    if (wait.threadId !== threadId) {
        return { kind: "cancelled" };
    }

    const waited = wait.attachmentIds.flatMap((id) => attachments.filter((attachment) => attachment.id === id));

    if (waited.length !== wait.attachmentIds.length) {
        return { kind: "cancelled" };
    }

    const failed = waited.find((attachment) => attachment.status === "error");

    if (failed) {
        return { kind: "failed", name: failed.name };
    }

    if (waited.some((attachment) => attachment.status !== "complete")) {
        return { kind: "waiting" };
    }

    return { kind: "send" };
};

/** The attachments a send waits on when pressed: every draft attachment not yet complete, with those already waited on. */
export const uploadWaitIds = (draft: ReadonlyArray<WaitedAttachment>, current: UploadWait | null): string[] => {
    const ids = new Set(current?.attachmentIds);

    for (const attachment of draft) {
        if (attachment.status !== "complete") {
            ids.add(attachment.id);
        }
    }

    return [...ids];
};
