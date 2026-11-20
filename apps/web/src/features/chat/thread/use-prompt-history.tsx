"use client";

/**
 * Wires `core/utils/prompt-history.ts` to the composer.
 *
 * The entries come from the thread's messages, which change on every streamed
 * chunk. Subscribing the composer itself to them would re-render the whole input
 * per chunk, so a render-less `<PromptHistorySource>` subscribes instead and
 * hands the entries to a ref the navigation callback reads on demand.
 */

import type { NotTypedDraft } from "@neore/backend/not-typed-text";
import type { FC } from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useChatMessages } from "@/features/chat/core/context/chat-context";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { composerDraftFrom } from "@/features/chat/core/utils/draft-origin";
import type { PromptHistoryDirection, PromptHistoryState } from "@/features/chat/core/utils/prompt-history";
import { buildPromptHistoryEntries, buildPromptHistoryMarks, isStillRecalled, navigatePromptHistory } from "@/features/chat/core/utils/prompt-history";

export const PromptHistorySource: FC<{ onEntries: (entries: string[], marks: ReadonlyMap<string, NotTypedDraft>) => void }> = ({ onEntries }) => {
    const { messages } = useChatMessages();

    useEffect(() => {
        onEntries(buildPromptHistoryEntries(messages), buildPromptHistoryMarks(messages));
    }, [onEntries, messages]);

    return null;
};

const sameText = (left: string, right: string): boolean => left.replaceAll(/\s+/g, " ").trim() === right.replaceAll(/\s+/g, " ").trim();

export const usePromptHistory = (getCurrentText: () => string) => {
    const entriesRef = useRef<string[]>([]);
    const marksRef = useRef<ReadonlyMap<string, NotTypedDraft>>(new Map());
    const stateRef = useRef<PromptHistoryState>(null);
    /** The draft's own mark before the first ArrowUp: it comes back with the draft. */
    const draftMarkRef = useRef<NotTypedDraft | undefined>(undefined);
    /** The text a step puts in the composer and the mark it carries, applied once the composer holds that text. */
    const pendingRef = useRef<{ mark: NotTypedDraft | undefined; text: string } | undefined>(undefined);

    const navigate = useCallback(
        (direction: PromptHistoryDirection): string | null => {
            const step = navigatePromptHistory(stateRef.current, direction, entriesRef.current, getCurrentText());

            if (!step) {
                return null;
            }

            if (stateRef.current === null) {
                draftMarkRef.current = composerDraftFrom();
            }

            stateRef.current = step.state;
            // A recalled entry replaces the draft as a whole: the mark is the entry's message's, or the draft's own on the way back.
            pendingRef.current = { mark: step.state === null ? draftMarkRef.current : marksRef.current.get(step.text), text: step.text };

            return step.text;
        },
        [getCurrentText],
    );

    /** Call on every text change, after the store has it: editing a recalled entry turns it into the draft. */
    const onTextChange = useCallback((text: string) => {
        const pending = pendingRef.current;

        if (pending && sameText(pending.text, text)) {
            pendingRef.current = undefined;

            if (text.trim() !== "") {
                useChatUIStore.getState().setComposerDraftFrom(pending.mark);
            }
        }

        if (stateRef.current && !isStillRecalled(stateRef.current, entriesRef.current, text)) {
            stateRef.current = null;
        }
    }, []);

    const isRecalled = useCallback(() => stateRef.current !== null, []);

    const setEntries = useCallback((entries: string[], marks: ReadonlyMap<string, NotTypedDraft> = new Map()) => {
        entriesRef.current = entries;
        marksRef.current = marks;
    }, []);

    const reset = useCallback(() => {
        stateRef.current = null;
        pendingRef.current = undefined;
    }, []);

    return useMemo(() => {
        return { isRecalled, navigate, onTextChange, reset, setEntries };
    }, [isRecalled, navigate, onTextChange, reset, setEntries]);
};
