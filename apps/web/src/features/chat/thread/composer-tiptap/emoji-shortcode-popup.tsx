"use client";

/**
 * EmojiShortcodePopup - the `:shortcode` list above the composer.
 *
 * Focus stays in the editor: the editable names the highlighted row through aria-activedescendant, so the rows are not
 * focused and take no key listener of their own. It is portalled and fixed to the composer's box, so opening it moves no line.
 */
import { useLingui } from "@lingui/react/macro";
import clsx from "clsx";
import type { FC } from "react";
import { createPortal } from "react-dom";

import type { EmojiSuggestion } from "./emoji-shortcode/search";
import { POPUP_ENTER_MOTION, POPUP_ROW_MOTION } from "./popup-motion";
import { emojiOptionId } from "./use-emoji-shortcode";

interface EmojiShortcodePopupProps {
    /** Rect of the composer, for positioning. */
    editorRect: DOMRect | null;
    listboxId: string;
    /** Moves the highlight to a row (the pointer is over it). */
    onHighlight: (index: number) => void;
    /** Inserts the emoji of a row. */
    onSelect: (index: number) => void;
    open: boolean;
    selected: number;
    suggestions: ReadonlyArray<EmojiSuggestion>;
}

const EmojiShortcodePopup: FC<EmojiShortcodePopupProps> = ({ editorRect, listboxId, onHighlight, onSelect, open, selected, suggestions }) => {
    const { t } = useLingui();

    if (!open || !editorRect) {
        return null;
    }

    return createPortal(
        <div
            className="fixed z-50"
            style={{
                left: `${editorRect.left}px`,
                top: `${editorRect.top}px`,
                transform: "translateY(calc(-100% - 6px))",
            }}
        >
            <div
                aria-label={t`Emoji suggestions`}
                className={clsx(
                    "overflow-hidden rounded-lg border p-1",
                    "bg-popover text-popover-foreground",
                    "dark:bg-[oklch(0.205_0_0)] dark:text-[oklch(0.985_0_0)]",
                    "border-border dark:border-white/10",
                    "shadow-md dark:shadow-xl dark:shadow-black/50",
                    "ring-foreground/10 ring-1 dark:ring-white/10",
                    POPUP_ENTER_MOTION,
                )}
                id={listboxId}
                role="listbox"
                style={{ width: editorRect.width }}
            >
                {suggestions.map((suggestion, position) => (
                    // A button, so the click needs no key handler: it takes no focus (tabIndex -1, mousedown is prevented)
                    // and the editor keeps the keyboard.
                    <button
                        aria-selected={position === selected}
                        className={clsx(
                            "pointer-coarse:min-h-11 flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                            POPUP_ROW_MOTION,
                            position === selected && "bg-accent text-accent-foreground",
                        )}
                        id={emojiOptionId(listboxId, position)}
                        key={suggestion.emoji}
                        onClick={() => onSelect(position)}
                        onMouseDown={(event) => {
                            // Keeps the editor focused; the insert runs on the click, which touch and assistive technology send too.
                            event.preventDefault();
                        }}
                        onMouseEnter={() => onHighlight(position)}
                        role="option"
                        tabIndex={-1}
                        type="button"
                    >
                        <span aria-hidden="true" className="shrink-0 text-lg leading-none">
                            {suggestion.emoji}
                        </span>
                        <span className="truncate font-mono">
                            :{suggestion.shortcode.slice(0, suggestion.matchIndex)}
                            <strong className="font-semibold">
                                {suggestion.shortcode.slice(suggestion.matchIndex, suggestion.matchIndex + suggestion.matchLength)}
                            </strong>
                            {suggestion.shortcode.slice(suggestion.matchIndex + suggestion.matchLength)}:
                        </span>
                    </button>
                ))}
            </div>
        </div>,
        document.body,
    );
};

export default EmojiShortcodePopup;
