/** What a text-to-file conversion came back with: the attachment's id, and the reason it failed (absent on success). */
export interface TextFileResult {
    attachmentId: string;
    error?: string;
}

interface MoveDraftToFileOptions {
    /** Uploads `draft` as a text attachment. */
    attach: (draft: string) => Promise<TextFileResult>;
    /** Empties the composer's text. */
    clearDraft: () => void;
    /** Drops the attachment that failed. */
    discard: (attachmentId: string) => void;
    /** Ids of the attachments in the composer right now. */
    getAttachmentIds: () => string[];
    /** The text in the composer right now. */
    getDraft: () => string;
    /** Called with the reason when the upload failed; the draft is still in the composer. */
    onFailure: (error: string) => void;
}

/** The characters a text attachment of `draft` adds to the context: its UTF-8 bytes, as `attachmentTextChars` counts them. */
export const draftFileChars = (draft: string): number => new TextEncoder().encode(draft).length;

/** Whether `draft`, as a file next to the attachments already there, stays inside the attachment and context limits. */
export const draftFitsAsFile = (draft: string, otherAttachmentChars: number, limits: { contextChars: number; maxFileBytes: number }): boolean => {
    const bytes = draftFileChars(draft);

    return bytes <= limits.maxFileBytes && bytes + otherAttachmentChars < limits.contextChars;
};

/**
 * Moves the draft into a file. The composer is emptied only once the upload succeeded, and only if the text is still the
 * draft that was uploaded: on a failure the text stays and the failed chip goes, so nothing is lost.
 */
export const moveDraftToFile = async ({ attach, clearDraft, discard, getAttachmentIds, getDraft, onFailure }: MoveDraftToFileOptions): Promise<boolean> => {
    const draft = getDraft();
    const { attachmentId, error } = await attach(draft);

    if (error !== undefined) {
        discard(attachmentId);
        onFailure(error);

        return false;
    }

    // Typing during the upload is not in the file, and a file removed meanwhile is gone: either way the text stays.
    if (getDraft() === draft && getAttachmentIds().includes(attachmentId)) {
        clearDraft();
    }

    return true;
};

interface UndoLongPasteOptions {
    attachmentId: string;
    getAttachmentIds: () => string[];
    getDraft: () => string;
    pastedText: string;
    removeAttachment: (attachmentId: string) => void;
    setDraft: (text: string) => void;
}

/** Puts a pasted text back in the draft and drops its file, unless the file is already gone (sent or removed): then there is nothing to undo. */
export const undoLongPaste = ({ attachmentId, getAttachmentIds, getDraft, pastedText, removeAttachment, setDraft }: UndoLongPasteOptions): boolean => {
    if (!getAttachmentIds().includes(attachmentId)) {
        return false;
    }

    removeAttachment(attachmentId);
    setDraft(getDraft() + pastedText);

    return true;
};
