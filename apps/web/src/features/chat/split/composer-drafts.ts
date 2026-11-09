import { create } from "zustand";

import type { ReferenceSelection } from "@/features/chat/components/reference-picker/types";
import type { PendingAttachment } from "@/features/chat/core/stores/chat-ui-store";
import type { ParkedModelState } from "@/features/chat/core/stores/model-store";

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
// Model choices of the chats whose pane is not focused. Not a draft: it shows no mark and a chat without text can hold one.
const parkedModels = new Map<string, ParkedModelState>();

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
    parkedModels.clear();
    syncParked();
};

/** The thread's parked draft, left in place. */
export const peekComposerDraft = (threadId: string): ComposerDraft | undefined => drafts.get(threadId);

export const hasDraftContent = (draft: Partial<ComposerDraft> | undefined): boolean =>
    draft !== undefined && ((draft.composerText ?? "") !== "" || (draft.composerAttachments?.length ?? 0) > 0 || (draft.attachedReferences?.length ?? 0) > 0);

/**
 * Patches an attachment that is not in the live composer because its chat's draft was parked while it uploaded.
 * Returns whether a parked draft held it.
 */
export const updateParkedAttachment = (id: string, updates: Partial<PendingAttachment>): boolean => {
    for (const [threadId, draft] of drafts) {
        if (draft.composerAttachments.some((a) => a.id === id)) {
            drafts.set(threadId, { ...draft, composerAttachments: draft.composerAttachments.map((a) => (a.id === id ? { ...a, ...updates } : a)) });

            return true;
        }
    }

    return false;
};

export const saveParkedModelState = (threadId: string, state: ParkedModelState): void => {
    parkedModels.set(threadId, state);
};

export const peekParkedModelState = (threadId: string): ParkedModelState | undefined => parkedModels.get(threadId);

/** The thread's parked model state, removed on the way out. */
export const takeParkedModelState = (threadId: string): ParkedModelState | undefined => {
    const state = parkedModels.get(threadId);

    parkedModels.delete(threadId);

    return state;
};

/** Forgets the model state of every chat that is not in `keep` (a pane that closed). */
export const pruneParkedModelStates = (keep: ReadonlyArray<string>): void => {
    for (const threadId of parkedModels.keys()) {
        if (!keep.includes(threadId)) {
            parkedModels.delete(threadId);
        }
    }
};
