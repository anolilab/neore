/**
 * Whether a chat that is about to be CREATED starts temporary, and the fields
 * that say so. The composer's explicit pick (`pendingSettings.isTempChat`, from
 * the temporary-chat dropdown) wins; otherwise the user's `newChatsTemporary`
 * default decides. Every path that creates a chat calls this, so they agree.
 */
import type { PendingSettings } from "../stores/model-store";

export interface NewChatTemporaryFields {
    retentionHours?: number;
    temporary: true;
}

export const newChatTemporaryFields = (
    pendingSettings: Pick<PendingSettings, "isTempChat" | "retentionHours"> | null | undefined,
    newChatsTemporary: boolean,
): NewChatTemporaryFields | undefined => {
    if (!(pendingSettings?.isTempChat ?? newChatsTemporary)) {
        return undefined;
    }

    return pendingSettings?.retentionHours === undefined ? { temporary: true } : { retentionHours: pendingSettings.retentionHours, temporary: true };
};
