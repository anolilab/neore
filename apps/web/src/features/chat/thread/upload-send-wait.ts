import type { PendingAttachment } from "../core/stores/chat-ui-store";

type WaitedAttachment = Pick<PendingAttachment, "fileId" | "id" | "name" | "status">;

/** A reference image attached to the next message: only its id matters here. */
interface WaitedReference {
    id: string;
}

/** The draft a send is about: its text, its attachments and its reference images, in order. */
export interface Draft {
    attachments: ReadonlyArray<WaitedAttachment>;
    references: ReadonlyArray<WaitedReference>;
    text: string;
}

/** An attachment as the send pressed on it: its id, and the uploaded file it had then, if it had finished. */
interface PressedAttachment {
    fileId: string | undefined;
    id: string;
}

/**
 * A send pressed while uploads run. It holds the draft as it was when send was pressed, so only that message goes out:
 * the rest of the fields are what the draft must still be, and `attachmentIds` are the uploads it waits for.
 */
export interface UploadWait {
    attachmentIds: ReadonlyArray<string>;
    pressedAttachments: ReadonlyArray<PressedAttachment>;
    referenceIds: ReadonlyArray<string>;
    text: string;
    threadId: string | undefined;
}

export type UploadWaitOutcome = { kind: "cancelled" } | { kind: "edited" } | { kind: "failed"; name: string } | { kind: "send" } | { kind: "waiting" };

const pressedAttachment = (attachment: WaitedAttachment): PressedAttachment => {
    return { fileId: attachment.fileId, id: attachment.id };
};

/** The wait a send pressed on `draft` starts with. */
export const startUploadWait = (draft: Draft, threadId: string | undefined): UploadWait => {
    return {
        attachmentIds: draft.attachments.filter((attachment) => attachment.status !== "complete").map((attachment) => attachment.id),
        pressedAttachments: draft.attachments.map((attachment) => pressedAttachment(attachment)),
        referenceIds: draft.references.map((reference) => reference.id),
        text: draft.text,
        threadId,
    };
};

/**
 * The same attachments as pressed. An attachment that was still uploading has no file yet, so its file is not compared;
 * one that had finished must still hold the same file, so an edit that replaces it ends the wait.
 */
const sameAttachments = (attachments: ReadonlyArray<WaitedAttachment>, pressed: ReadonlyArray<PressedAttachment>): boolean =>
    attachments.length === pressed.length &&
    attachments.every((attachment, index) => {
        const before = pressed[index];

        return attachment.id === before?.id && (before.fileId === undefined || attachment.fileId === before.fileId);
    });

const sameReferences = (references: ReadonlyArray<WaitedReference>, ids: ReadonlyArray<string>): boolean =>
    references.length === ids.length && references.every((reference, index) => reference.id === ids[index]);

/**
 * What a waiting send does now that the draft or its uploads changed. It goes out only once every waited upload has
 * completed, and only as the draft that was pressed on. Any edit to the text, the attachments or the reference images
 * ends the wait: the user sends the new draft by pressing send again. A failed upload stops it. A chat change cancels
 * it quietly.
 */
export const settleUploadWait = (wait: UploadWait, draft: Draft, threadId: string | undefined): UploadWaitOutcome => {
    if (wait.threadId !== threadId) {
        return { kind: "cancelled" };
    }

    if (draft.text !== wait.text || !sameAttachments(draft.attachments, wait.pressedAttachments) || !sameReferences(draft.references, wait.referenceIds)) {
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
