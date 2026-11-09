import { create } from "zustand";

import type { ReferenceSelection } from "@/features/chat/components/reference-picker/types";
import type { PendingAttachment } from "@/features/chat/core/stores/chat-ui-store";

/**
 * Unsent composer state by thread, for the split view. The composer's draft (text, attachments, references) is one global
 * value, so when focus moves to another pane the outgoing state is parked here and the incoming pane's is taken back out.
 * Memory only: a reload starts with empty drafts, as a single chat does.
 */
export interface ComposerDraft {
    attachedReferences: ReferenceSelection[];
    composerAttachments: PendingAttachment[];
    composerText: string;
}

const drafts = new Map<string, ComposerDraft>();

/** The thread ids that have a parked draft, so a row or a pane header can show the mark. Replaced on each sync, never mutated. */
export const useParkedDraftStore = create<{ threadIds: ReadonlySet<string> }>()(() => {
    return { threadIds: new Set<string>() };
});

/**
 * Whether the split view is on the page. Only then is the focused pane's composer the live one of its chat: on `/chat` with
 * the preference on, the composer is the new-chat composer, and its text belongs to no pane.
 */
export const useSplitViewMountedStore = create<{ mounted: boolean }>()(() => {
    return { mounted: false };
});

export const setSplitViewMounted = (mounted: boolean): void => {
    useSplitViewMountedStore.setState({ mounted });
};

// Rows select a boolean from the set, so a fresh set that says the same thing re-renders nobody.
const syncParked = (): void => {
    useParkedDraftStore.setState({ threadIds: new Set(drafts.keys()) });
};

/** Parks a draft. A draft with nothing in it is forgotten. */
export const saveComposerDraft = (threadId: string, draft: Partial<ComposerDraft>): void => {
    const { attachedReferences = [], composerAttachments = [], composerText = "" } = draft;

    if (composerText === "" && composerAttachments.length === 0 && attachedReferences.length === 0) {
        drafts.delete(threadId);
    } else {
        drafts.set(threadId, { attachedReferences, composerAttachments, composerText });
    }

    syncParked();
};

/** The thread's parked draft, removed on the way out; empty when there is none. */
export const takeComposerDraftState = (threadId: string): ComposerDraft => {
    const draft = drafts.get(threadId) ?? { attachedReferences: [], composerAttachments: [], composerText: "" };

    drafts.delete(threadId);
    syncParked();

    return draft;
};

export const clearComposerDrafts = (): void => {
    drafts.clear();
    syncParked();
};
