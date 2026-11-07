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
/** Whether a paste carries text as well as any files: the editor inserts that text, so the paste is not taken whole. */
export const pasteHasText = (data: Pick<DataTransfer, "types">): boolean => data.types.includes("text/plain") || data.types.includes("text/html");

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

/** `text` spliced into `draft` over the offsets `start` to `end`, as a normal paste would; offsets past the end land at the end. */
export const insertPastedText = (draft: string, text: string, start: number, end: number): string => {
    const from = Math.min(start, draft.length);
    const to = Math.min(Math.max(end, from), draft.length);

    return draft.slice(0, from) + text + draft.slice(to);
};

interface AttachLongPasteOptions {
    attach: (text: string) => Promise<TextFileResult>;
    discard: (attachmentId: string) => void;
    /** Ids of the attachments in the composer right now. */
    getAttachmentIds: () => string[];
    /** The chat the composer belongs to right now; a paste is never written into a different one than it started in. */
    getChatKey: () => string | null | undefined;
    getDraft: () => string;
    /** Called with the new attachment's id once the text is a file that is still in the composer. */
    onAttached: (attachmentId: string) => void;
    /** Called with the reason when the text could not become a file; the text is already back in the composer. */
    onFailure: (error: string) => void;
    /** Called instead of `onFailure` when the user left the chat meanwhile: the text went nowhere, the other chat's draft is untouched. */
    onNotInserted: (error: string) => void;
    pastedText: string;
    /** Where the paste landed in the draft, read before the upload started. */
    selection: { end: number; start: number };
    setDraft: (text: string) => void;
}

/**
 * Moves a pasted text (whose default paste was prevented) into a file. When that fails the text goes into the composer at
 * the paste position instead and the failed chip goes, so the paste is never in neither place. If the draft changed during
 * the upload the text is appended, since the saved offsets no longer point at the same characters; if the chat changed,
 * nothing is written at all.
 */
export const attachLongPaste = async ({
    attach,
    discard,
    getAttachmentIds,
    getChatKey,
    getDraft,
    onAttached,
    onFailure,
    onNotInserted,
    pastedText,
    selection,
    setDraft,
}: AttachLongPasteOptions): Promise<boolean> => {
    const chatKey = getChatKey();
    const draftAtPaste = getDraft();
    const { attachmentId, error } = await attach(pastedText);

    if (error === undefined) {
        // A file removed during the upload is gone: announcing it (and offering Undo) would be false.
        if (getAttachmentIds().includes(attachmentId)) {
            onAttached(attachmentId);
        }

        return true;
    }

    discard(attachmentId);

    if (getChatKey() !== chatKey) {
        onNotInserted(error);

        return false;
    }

    const draft = getDraft();

    setDraft(draft === draftAtPaste ? insertPastedText(draft, pastedText, selection.start, selection.end) : draft + pastedText);
    onFailure(error);

    return false;
};
