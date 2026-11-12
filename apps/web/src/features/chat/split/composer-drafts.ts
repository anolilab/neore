import { create } from "zustand";

import type { ReferenceSelection } from "@/features/chat/components/reference-picker/types";
import type { PendingAttachment } from "@/features/chat/core/stores/chat-ui-store";
import type { ParkedModelState } from "@/features/chat/core/stores/model-store";

/**
 * Unsent composer state by thread, for the split view. The composer's draft (text, attachments, references) is one global
 * value, so when focus moves to another pane the outgoing state is parked here and the incoming pane's is taken back out.
 * A copy of every draft is kept in `localStorage` for a reload (`stored-drafts.ts`, loaded lazily); its keys and their removal
 * live here, so sign-out can drop them without loading that module.
 */
export interface ComposerDraft {
    attachedReferences: ReferenceSelection[];
    composerAttachments: PendingAttachment[];
    composerText: string;
}

const drafts = new Map<string, ComposerDraft>();
// Model choices of the chats whose pane is not focused. Not a draft: it shows no mark and a chat without text can hold one.
const parkedModels = new Map<string, ParkedModelState>();
// A worker's unsent message, by worker thread. Its composer unmounts when focus moves, so the text waits here.
const workerDrafts = new Map<string, string>();
// The key prefix each clear (sign-out, account switch) removed: one account's, or every account's. A write-back that started
// before a clear of its account must not land after it.
const cleared: string[] = [];

/**
 * What the lazy storage module (`stored-drafts.ts`) needs before it loads, and its hand-over once it has. Here because the first
 * page load carries every byte: the chat whose composer holds the text (`use-stored-drafts.ts`; typed before the module binds, it
 * is that chat's), the message a route last put in the composer (until edited, no chat's draft) and the module's hand-over when
 * focus moves to another pane (`watchPaneFocus`).
 */
export const draftOwnership: {
    first?: { generation: number; owner: string; userId: string };
    handOver?: (owner: string | undefined) => void;
    prefill?: string;
} = {};

/**
 * `neore-draft-cleared:<userId | *>`: `<ms>:<random>`, written each time a tab removes that account's drafts (every account's for
 * `*`). Not a draft key. Tabs compare the whole value, never its time, so a clock set back cannot pass an old clear off as new.
 */
const CLEARED_KEY_PREFIX = "neore-draft-cleared:";
const ALL_ACCOUNTS = "*";

/** The clear markers that concern `userId` (its own, then every account's), "" for none or unreadable. A change is a new clear. */
export const draftClearMarks = (userId: string): string[] => {
    try {
        return [userId, ALL_ACCOUNTS].map((account) => globalThis.localStorage.getItem(`${CLEARED_KEY_PREFIX}${account}`) ?? "");
    } catch {
        return ["", ""];
    }
};

/**
 * Removes the clear markers older than `maxAgeMs` (the drafts' TTL): by then no tab still holds a binding from before them that
 * has not written since, and a departed account's id does not stay on the device for good. Unreadable markers go too.
 */
export const pruneClearMarkers = (maxAgeMs: number, now = Date.now()): void => {
    try {
        for (const key of Object.keys(globalThis.localStorage)) {
            if (!key.startsWith(CLEARED_KEY_PREFIX)) {
                continue;
            }

            const at = Number.parseInt(globalThis.localStorage.getItem(key) ?? "", 10);

            if (!Number.isFinite(at) || at < now - maxAgeMs) {
                globalThis.localStorage.removeItem(key);
            }
        }
    } catch {
        // Blocked storage holds no markers.
    }
};

/**
 * Removes `userId`'s stored drafts, never another account's; every account's when `userId` is undefined (a sign-out that could
 * not read who signs out). For sign-out and an account switch: the drafts are the account's, not the browser's. It moves the
 * account's generation on, so a write scheduled before it drops itself.
 */
export const dropStoredDrafts = (userId?: string): void => {
    // Each stored draft is one entry, `neore-draft:<userId>:<owner>` (`stored-drafts.ts`).
    const prefix = userId === undefined ? "neore-draft:" : `neore-draft:${userId}:`;

    cleared.push(prefix);

    try {
        for (const key of Object.keys(globalThis.localStorage)) {
            if (key.startsWith(prefix)) {
                globalThis.localStorage.removeItem(key);
            }
        }
    } catch {
        // Blocked storage holds nothing to remove.
    }

    // After the removal, which frees the space it needs, and on its own: a full storage never keeps the drafts in place.
    try {
        // Other tabs of the account read it before their next write (`draftClearMarks`): their drafts must not come back either.
        globalThis.localStorage.setItem(`${CLEARED_KEY_PREFIX}${userId ?? ALL_ACCOUNTS}`, `${Date.now()}:${Math.random().toString(36).slice(2)}`);
    } catch {
        // Blocked or full: the other tabs forget the account when their own sign-out runs.
    }
};

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

export const clearComposerDrafts = (userId?: string): void => {
    drafts.clear();
    parkedModels.clear();
    workerDrafts.clear();
    dropStoredDrafts(userId);
    syncParked();
};

/**
 * The clears so far; with `userId`, those that removed its drafts. A write-back captures it when it starts and drops itself when
 * the value has moved on.
 */
export const draftGeneration = (userId?: string): number =>
    userId === undefined ? cleared.length : cleared.filter((prefix) => `neore-draft:${userId}:`.startsWith(prefix)).length;

/** A worker's unsent message, kept while its composer is not shown. Empty text is forgotten. */
export const saveWorkerDraft = (workerId: string, text: string): void => {
    if (text === "") {
        workerDrafts.delete(workerId);
    } else {
        workerDrafts.set(workerId, text);
    }
};

export const peekWorkerDraft = (workerId: string): string | undefined => workerDrafts.get(workerId);

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
            // So the stored copy picks up the finished upload.
            syncParked();

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

/**
 * Forgets the model state of every chat that is neither in `keep` (an open pane) nor has a parked draft. A closed chat's draft can
 * still be reopened, and its unsent model choices come back with it.
 */
export const pruneParkedModelStates = (keep: ReadonlyArray<string>): void => {
    for (const threadId of parkedModels.keys()) {
        if (!keep.includes(threadId) && !drafts.has(threadId)) {
            parkedModels.delete(threadId);
        }
    }
};
