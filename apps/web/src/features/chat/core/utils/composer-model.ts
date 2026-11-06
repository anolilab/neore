import { ANONYMOUS_FREE_MODEL } from "@neore/ai/constants";

import type { ComposerMode } from "../stores/model-store";
import { MIN_COMPARISON_MODELS } from "../stores/model-store";

/**
 * The model the composer shows, and so the model a send is meant to run on. A bot chat shows the bot's current model (its
 * thread may still store an older one). An anonymous person's text chat shows the free model, whatever the thread stores;
 * in image, video or audio mode the mode's own model stands. The composer's picker and the prompt-link copy both read this
 * rule, so they cannot disagree about the model a copied link names.
 */
export const composerModelOf = ({
    botModel,
    isAnonymous,
    mode,
    threadModel,
}: {
    /** The bot's current model, when the chat is a bot chat and its bot is one the person can see. */
    botModel?: string;
    isAnonymous: boolean;
    mode: ComposerMode;
    threadModel: string;
}): string => botModel ?? (isAnonymous && mode === "text" ? ANONYMOUS_FREE_MODEL : threadModel);

/** The composer mode of a chat: its own once the thread exists, else the mode the new-chat composer is in. */
export const composerModeOf = ({
    newThreadMode,
    threadId,
    threadMode,
}: {
    newThreadMode: ComposerMode;
    threadId: string | undefined;
    /** The thread's stored mode, read from the model store's per-thread map. */
    threadMode: ComposerMode | undefined;
}): ComposerMode => (threadId ? (threadMode ?? "text") : newThreadMode);

/**
 * Whether a send fans out to several models: the composer's comparison is on with the minimum number of models. The composer
 * sends that way and a prompt link cannot name it, so both read this one rule.
 */
export const sendsToComparison = ({
    comparisonMode,
    selectedModelsForComparison,
}: {
    comparisonMode: boolean;
    selectedModelsForComparison: ReadonlyArray<string>;
}): boolean => comparisonMode && selectedModelsForComparison.length >= MIN_COMPARISON_MODELS;
