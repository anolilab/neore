"use client";

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useEffectEvent, useId, useMemo, useState } from "react";

import { getLoadedEmojiIndex, loadEmojiIndex } from "./emoji-shortcode/emoji-index";
import type { EmojiIndex, EmojiSuggestion } from "./emoji-shortcode/search";
import { searchEmojiShortcodes } from "./emoji-shortcode/search";
import type { EmojiShortcodeMatch } from "./extensions/emoji-shortcode";

const NO_SUGGESTIONS: ReadonlyArray<EmojiSuggestion> = [];

export const emojiOptionId = (listboxId: string, index: number): string => `${listboxId}-option-${index}`;

interface UseEmojiShortcodeOptions {
    /** Whether the list may open: suggestions are on and no other composer popup is open. */
    enabled: boolean;
    match: EmojiShortcodeMatch | null;
    /** Replaces the typed range with the emoji. */
    onReplace: (from: number, to: number, replacement: string) => void;
}

/**
 * The `:shortcode` list above the composer: which rows, which one is highlighted, and the keys that move it. The keys
 * are a window capture listener while the list is open, so they take Enter, Tab, the arrows and Escape before the editor
 * does; Escape closes the list and leaves the text as typed, until the shortcode itself ends.
 */
export const useEmojiShortcode = ({ enabled, match, onReplace }: UseEmojiShortcodeOptions) => {
    const { t } = useLingui();
    const listboxId = useId();
    const [index, setIndex] = useState<EmojiIndex | undefined>(getLoadedEmojiIndex);
    const [activeIndex, setActiveIndex] = useState(0);
    const [activeQuery, setActiveQuery] = useState<string | undefined>(undefined);
    const [dismissedFrom, setDismissedFrom] = useState<number | null>(null);
    const query = match?.query;

    // The index loads once per page, started as soon as the composer can show the list.
    useEffect(() => {
        if (!enabled || index !== undefined) {
            return undefined;
        }

        let cancelled = false;

        const load = async (): Promise<void> => {
            try {
                const loaded = await loadEmojiIndex();

                if (!cancelled) {
                    setIndex(loaded);
                }
            } catch {
                // The list stays off until a reload; the composer itself does not need it.
            }
        };

        void load();

        return () => {
            cancelled = true;
        };
    }, [enabled, index]);

    // Derived state, adjusted during render: a new query starts at the top of the list, and a finished shortcode forgets
    // that it was dismissed, so the next one opens.
    if (query !== activeQuery) {
        setActiveQuery(query);
        setActiveIndex(0);
    }

    if (match === null && dismissedFrom !== null) {
        setDismissedFrom(null);
    }

    const suggestions = useMemo(
        () => (enabled && index !== undefined && query !== undefined ? searchEmojiShortcodes(index, query) : NO_SUGGESTIONS),
        [enabled, index, query],
    );

    const isDismissed = match !== null && match.from === dismissedFrom;
    const open = enabled && match !== null && !isDismissed && suggestions.length > 0;
    const selected = Math.min(activeIndex, Math.max(suggestions.length - 1, 0));

    const select = useCallback(
        (position: number): void => {
            const suggestion = suggestions[position];

            if (match && suggestion) {
                onReplace(match.from, match.to, suggestion.emoji);
            }
        },
        [match, onReplace, suggestions],
    );

    // Effect Event: the listener is attached once per open/close, not re-attached on every keystroke that changes the rows.
    const onKeyDown = useEffectEvent((event: KeyboardEvent): void => {
        if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) {
            return;
        }

        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            const step = event.key === "ArrowDown" ? 1 : -1;

            setActiveIndex((selected + step + suggestions.length) % suggestions.length);
        } else if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
            select(selected);
        } else if (match && event.key === "Escape") {
            setDismissedFrom(match.from);
        } else {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
    });

    useEffect(() => {
        if (!open) {
            return undefined;
        }

        const handleKeyDown = (event: KeyboardEvent): void => onKeyDown(event);

        globalThis.addEventListener("keydown", handleKeyDown, { capture: true });

        return () => globalThis.removeEventListener("keydown", handleKeyDown, { capture: true });
    }, [open]);

    // Empty until the index is in and a shortcode is being typed, so a screen reader hears the count, not a stale one.
    let announcement = "";

    if (index !== undefined && enabled && match !== null && !isDismissed) {
        announcement = suggestions.length === 0 ? t`No emoji found` : t`${plural(suggestions.length, { one: "# emoji", other: "# emoji" })} found`;
    }

    return {
        activeOptionId: open ? emojiOptionId(listboxId, selected) : undefined,
        announcement,
        highlight: setActiveIndex,
        listboxId,
        open,
        select,
        selected,
        suggestions: open ? suggestions : NO_SUGGESTIONS,
    };
};
