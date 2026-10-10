"use client";

/**
 * Wires `core/utils/prompt-history.ts` to the composer.
 *
 * The entries come from the thread's messages, which change on every streamed
 * chunk. Subscribing the composer itself to them would re-render the whole input
 * per chunk, so a render-less `<PromptHistorySource>` subscribes instead and
 * hands the entries to a ref the navigation callback reads on demand.
 */

import type { FC } from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useChatMessages } from "@/features/chat/core/context/chat-context";
import type { PromptHistoryDirection, PromptHistoryState } from "@/features/chat/core/utils/prompt-history";
import { buildPromptHistoryEntries, isStillRecalled, navigatePromptHistory } from "@/features/chat/core/utils/prompt-history";

export const PromptHistorySource: FC<{ onEntries: (entries: string[]) => void }> = ({ onEntries }) => {
    const { messages } = useChatMessages();

    useEffect(() => {
        onEntries(buildPromptHistoryEntries(messages));
    }, [onEntries, messages]);

    return null;
};

export const usePromptHistory = (getCurrentText: () => string) => {
    const entriesRef = useRef<string[]>([]);
    const stateRef = useRef<PromptHistoryState>(null);

    const navigate = useCallback(
        (direction: PromptHistoryDirection): string | null => {
            const step = navigatePromptHistory(stateRef.current, direction, entriesRef.current, getCurrentText());

            if (!step) {
                return null;
            }

            stateRef.current = step.state;

            return step.text;
        },
        [getCurrentText],
    );

    /** Call on every text change: editing a recalled entry turns it into the draft. */
    const onTextChange = useCallback((text: string) => {
        if (stateRef.current && !isStillRecalled(stateRef.current, entriesRef.current, text)) {
            stateRef.current = null;
        }
    }, []);

    const setEntries = useCallback((entries: string[]) => {
        entriesRef.current = entries;
    }, []);

    const reset = useCallback(() => {
        stateRef.current = null;
    }, []);

    return useMemo(() => {
        return { navigate, onTextChange, reset, setEntries };
    }, [navigate, onTextChange, reset, setEntries]);
};
