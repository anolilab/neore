import type { PendingAttachment } from "../core/stores/chat-ui-store";

type WaitedAttachment = Pick<PendingAttachment, "id" | "name" | "status">;

/** The draft a send is about: its text and its attachments, in order. */
export interface Draft {
    attachments: ReadonlyArray<WaitedAttachment>;
    text: string;
}

/**
 * A send pressed while uploads run. It holds the draft as it was when send was pressed, so only that message goes out:
 * `draftIds` and `text` are what the draft must still be, and `attachmentIds` are the uploads it waits for.
 */
export interface UploadWait {
    attachmentIds: ReadonlyArray<string>;
    draftIds: ReadonlyArray<string>;
    text: string;
    threadId: string | undefined;
}

export type UploadWaitOutcome = { kind: "cancelled" } | { kind: "edited" } | { kind: "failed"; name: string } | { kind: "send" } | { kind: "waiting" };

/** The wait a send pressed on `draft` starts with. */
export const startUploadWait = (draft: Draft, threadId: string | undefined): UploadWait => {
    return {
        attachmentIds: draft.attachments.filter((attachment) => attachment.status !== "complete").map((attachment) => attachment.id),
        draftIds: draft.attachments.map((attachment) => attachment.id),
        text: draft.text,
        threadId,
    };
};

const sameDraftAttachments = (attachments: ReadonlyArray<WaitedAttachment>, ids: ReadonlyArray<string>): boolean =>
    attachments.length === ids.length && attachments.every((attachment, index) => attachment.id === ids[index]);

/**
 * What a waiting send does now that the draft or its uploads changed. It goes out only once every waited upload has
 * completed, and only as the draft that was pressed on. Any edit to the text or the attachments ends the wait: the
 * user sends the new draft by pressing send again. A failed upload stops it. A chat change cancels it quietly.
 */
export const settleUploadWait = (wait: UploadWait, draft: Draft, threadId: string | undefined): UploadWaitOutcome => {
    if (wait.threadId !== threadId) {
        return { kind: "cancelled" };
    }

    if (draft.text !== wait.text || !sameDraftAttachments(draft.attachments, wait.draftIds)) {
        return { kind: "edited" };
    }

    const waited = draft.attachments.filter((attachment) => wait.attachmentIds.includes(attachment.id));
    const failed = waited.find((attachment) => attachment.status === "error");

    if (failed) {
        return { kind: "failed", name: failed.name };
    }

    if (waited.some((attachment) => attachment.status !== "complete")) {
        return { kind: "waiting" };
    }

    return { kind: "send" };
};
