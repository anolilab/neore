import { stripHiddenText } from "@neore/ai/utils";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import type { ComposerMode, PendingSettings } from "@/features/chat/core/stores/model-store";
import { useModelStore } from "@/features/chat/core/stores/model-store";
import { useUIStateStore } from "@/features/layout/stores/ui-state-store";

import type { ComposerDraft } from "./composer-drafts";
import {
    hasDraftContent,
    peekComposerDraft,
    peekParkedModelState,
    pruneParkedModelStates,
    saveComposerDraft,
    saveParkedModelState,
    takeComposerDraftState,
    takeParkedModelState,
    useSplitViewMountedStore,
} from "./composer-drafts";
import { useSplitLayoutStore } from "./split-layout-store";

/**
 * State that belongs to one chat but lives in a global store (the composer's draft, the picked model and the pending settings).
 * With the split view on, only the focused pane's chat owns the live store; every other chat's is parked in `composer-drafts`.
 * A write-back that comes late (a failed send, a finished upload) carries the chat it started from, captured when the action
 * began, and `isOwnerLive` decides where it goes.
 */

/**
 * Whether the chat's state is what the live stores hold. Without the split preference there is one chat and the stores are
 * its own. With it, only the focused pane of a mounted split view is live; on `/chat` no pane owns the composer, so a chat's
 * late write-back is parked instead of landing in the new-chat composer. A new chat (no id) has only the live composer.
 */
export const isOwnerLive = (ownerId: string | undefined): boolean => {
    if (ownerId === undefined || useUIStateStore.getState().preferences.splitViewEnabled !== true) {
        return true;
    }

    if (!useSplitViewMountedStore.getState().mounted) {
        return false;
    }

    const { layout } = useSplitLayoutStore.getState();

    return layout.panes[layout.focus] === ownerId;
};

type ComposerContent = Pick<ComposerDraft, "attachedReferences" | "composerAttachments" | "composerText">;

/** Hands a failed send's text back to the chat that sent it: its live composer when it is focused, else its parked draft. */
export const restoreTextFor = (ownerId: string | undefined, text: string): void => {
    if (ownerId === undefined || isOwnerLive(ownerId)) {
        useChatUIStore.getState().setComposerText(text);

        return;
    }

    const parked = peekComposerDraft(ownerId);

    if (hasDraftContent(parked)) {
        return;
    }

    saveComposerDraft(ownerId, { ...parked, composerText: stripHiddenText(text).text });
};

/** Puts a failed send back, unless the owner started a new draft meanwhile: its live one when focused, else its parked one. */
export const restoreComposerFor = (ownerId: string | undefined, draft: ComposerContent): void => {
    if (ownerId === undefined || isOwnerLive(ownerId)) {
        useChatUIStore.getState().restoreComposer(draft);

        return;
    }

    if (hasDraftContent(peekComposerDraft(ownerId))) {
        return;
    }

    saveComposerDraft(ownerId, { ...draft, composerText: stripHiddenText(draft.composerText).text });
};

/** Parks the live composer under the chat that owns it, and empties it. */
const parkLiveComposer = (threadId: string): void => {
    const ui = useChatUIStore.getState();

    saveComposerDraft(threadId, {
        attachedReferences: ui.attachedReferences,
        composerAttachments: ui.composerAttachments,
        composerText: ui.composerText,
    });
    ui.clearComposer();
};

/** Brings the chat's parked draft into the live composer. A composer that already has content is left alone, and so is the parked draft. */
export const restoreLiveComposerFor = (threadId: string): void => {
    const ui = useChatUIStore.getState();

    if (ui.composerText !== "" || ui.composerAttachments.length > 0 || ui.attachedReferences.length > 0) {
        return;
    }

    ui.restoreComposer(takeComposerDraftState(threadId));
};

/**
 * Sets aside the model, mode and pending settings the person chose in this chat, and clears the pending ones from the store so
 * the next chat does not inherit them. Only what the store holds for this chat is taken.
 */
const parkModelState = (threadId: string): void => {
    const state = useModelStore.getState();
    const ownsModel = state.selectedModelThreadId === threadId;
    const ownsMode = state.currentModeThreadId === threadId;

    if (!(ownsModel || ownsMode)) {
        return;
    }

    saveParkedModelState(threadId, {
        audioSettings: state.audioSettings,
        imageSettings: state.imageSettings,
        mode: state.threadModes.get(threadId),
        model: state.selectedModel,
        pendingSettings: ownsModel ? state.pendingSettings : undefined,
        userChangedMode: ownsMode && state.userChangedMode,
        userChangedModel: ownsModel && state.userChangedModel,
        videoSettings: state.videoSettings,
    });

    if (ownsModel) {
        state.setPendingSettings(undefined);
    }
};

/** A failed send's consumed settings go back to the chat's parked model state; what was picked since wins. */
export const parkSettingsFor = (threadId: string, consumed: PendingSettings): void => {
    const parked = peekParkedModelState(threadId) ?? { userChangedMode: false, userChangedModel: false };

    saveParkedModelState(threadId, { ...parked, pendingSettings: { ...consumed, ...parked.pendingSettings } });
};

interface FocusedModelInput {
    isLoaded: boolean;
    mode: ComposerMode | undefined;
    model: string | undefined;
    threadId: string;
}

/**
 * Makes the model store describe the focused pane's chat: its parked choices come back first, then its saved model and mode
 * load unless the person picked something there. Only the focused pane calls this; a background pane's chat never writes
 * the store, so it cannot reset what the focused pane shows.
 */
export const syncFocusedModel = ({ isLoaded, mode, model, threadId }: FocusedModelInput): void => {
    // Read before the restore below, which points the store at this chat.
    const describesChat = useModelStore.getState().selectedModelThreadId === threadId;
    const parked = takeParkedModelState(threadId);

    if (parked) {
        useModelStore.getState().restoreParkedState(threadId, parked);
    } else if (!describesChat) {
        // A chat that was never parked has no generation settings of its own: it starts from the defaults, not the previous chat's.
        useModelStore.getState().resetGenerationSettings();
    }

    const state = useModelStore.getState();

    if (!isLoaded) {
        // Not loaded yet: a clean slate rather than the previous chat's model.
        if (state.selectedModelThreadId !== threadId) {
            state.loadThreadData({}, threadId);
        }

        return;
    }

    const userChanged =
        (state.userChangedModel && state.selectedModelThreadId === threadId) || (state.userChangedMode && state.currentModeThreadId === threadId);

    if (!userChanged) {
        state.loadThreadData({ mode, model }, threadId, { keepComparison: describesChat });
    }
};

/**
 * The split view is going away. The focused pane's live draft goes back to its chat, so it is neither lost nor handed to the
 * composer that comes next (on `/chat` none of it is a pane's). Only when the preference was turned off does the routed chat
 * keep its text in the composer, because the single-chat page shows that chat in it; its parked draft comes back there too.
 */
export const leaveSplitView = (focusedThreadId: string | undefined, routeThreadId: string | undefined): void => {
    const isPreferenceOff = useUIStateStore.getState().preferences.splitViewEnabled !== true;

    if (focusedThreadId !== undefined && !(isPreferenceOff && focusedThreadId === routeThreadId)) {
        parkLiveComposer(focusedThreadId);
    }

    if (isPreferenceOff && routeThreadId !== undefined) {
        restoreLiveComposerFor(routeThreadId);
    }
};

/**
 * While the split view is mounted: when focus moves to another pane, the outgoing pane's model choices and composer are parked
 * at once, inside the layout change. Effects run after render, and the incoming pane's provider and sync (children run first)
 * would otherwise reset the store before a parent effect could save it.
 */
export const watchPaneFocus = (): (() => void) =>
    useSplitLayoutStore.subscribe((state, previous) => {
        const before = previous.layout.panes[previous.layout.focus];
        const after = state.layout.panes[state.layout.focus];

        if (before !== undefined && before !== after) {
            parkModelState(before);
            parkLiveComposer(before);
            // The outgoing chat's comparison is not the incoming one's: its own parent turns comparison back on when it has focus.
            useModelStore.setState({ comparisonMode: false, selectedModelsForComparison: [] });
        }

        pruneParkedModelStates(state.layout.panes);

        // A document whose pane has closed moves to the focused pane, so the panel can show it and its close control is reachable.
        const { canvasThreadId } = useChatUIStore.getState();

        if (canvasThreadId !== null && after !== undefined && !state.layout.panes.includes(canvasThreadId)) {
            useChatUIStore.setState({ canvasThreadId: after });
        }
    });
