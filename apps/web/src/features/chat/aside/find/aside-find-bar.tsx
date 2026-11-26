"use client";

import { useLingui } from "@lingui/react/macro";
import { Input } from "@neore/ui/components/input";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import type { ChangeEvent, FC, FormEvent, KeyboardEvent } from "react";
import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";

import TooltipIconButton from "@/features/chat/components/tooltip-icon-button";
import { clampIndex, MAX_FIND_QUERY_LENGTH, stepIndex } from "@/features/chat/thread/find/match";
import { ASIDE_FIND_EVENT } from "@/features/keyboard/lib/aside-find-target";

import useAsideFindHighlights from "./use-aside-find-highlights";

/**
 * Whether a key press belongs to an input method. Safari fires the key that ends a composition after `compositionend`, when
 * `isComposing` is already false, and marks it with keyCode 229 instead.
 */
// eslint-disable-next-line no-restricted-syntax -- Safari reports that key as `Enter` or `Escape` too, so keyCode is the only signal
const isImeKey = (event: globalThis.KeyboardEvent): boolean => event.isComposing || event.keyCode === 229;

/**
 * Find in the side questions: a bar at the top of the panel that searches the questions and answers as they are shown,
 * and paints the hits. Opened by the Find shortcut while focus is in the panel (`keyboard-shortcuts-manager.tsx`). The
 * count and the highlights come from the rendered panel (`use-aside-find-highlights.ts`), so they always agree.
 */
const AsideFindBar: FC = () => {
    const { t } = useLingui();
    const [isOpen, setIsOpen] = useState(false);
    const [query, setQuery] = useState("");
    // The step the reader asked for. It can name another hit once an earlier answer adds one, so the counter shows `position`.
    const [index, setIndex] = useState(0);
    const [position, setPosition] = useState(0);
    const [matchCount, setMatchCount] = useState(0);
    // Bumped by every navigation, so stepping onto the same hit scrolls back to it.
    const [revealKey, setRevealKey] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const barRef = useRef<HTMLFormElement>(null);
    const returnFocusRef = useRef<HTMLElement | null>(null);

    const deferredQuery = useDeferredValue(query);
    const activeIndex = clampIndex(position, matchCount);
    const handleMatches = useCallback((count: number, found: number) => {
        setMatchCount(count);
        setPosition(found);
    }, []);

    useAsideFindHighlights(barRef, isOpen, deferredQuery, index, revealKey, handleMatches);

    useEffect(() => {
        const open = () => {
            const { activeElement } = document;

            if (!barRef.current?.contains(activeElement) && activeElement instanceof HTMLElement) {
                returnFocusRef.current = activeElement;
            }

            setIsOpen(true);
            // The input mounts with the bar; focus it once it is there.
            requestAnimationFrame(() => {
                inputRef.current?.focus();
                inputRef.current?.select();
            });
        };

        globalThis.addEventListener(ASIDE_FIND_EVENT, open);

        return () => globalThis.removeEventListener(ASIDE_FIND_EVENT, open);
    }, []);

    const close = useCallback(() => {
        setIsOpen(false);

        const target = returnFocusRef.current;

        returnFocusRef.current = null;

        if (target?.isConnected) {
            target.focus();
        }
    }, []);

    // Escape from any control in the bar closes it. A listener rather than a JSX handler: the form is not itself interactive.
    useEffect(() => {
        const bar = barRef.current;

        if (!isOpen || !bar) {
            return undefined;
        }

        const handleEscape = (event: globalThis.KeyboardEvent) => {
            // An Escape that cancels an IME candidate belongs to the input method, not to the bar.
            if (event.key !== "Escape" || isImeKey(event)) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            close();
        };

        bar.addEventListener("keydown", handleEscape);

        return () => bar.removeEventListener("keydown", handleEscape);
    }, [isOpen, close]);

    const step = useCallback(
        (direction: -1 | 1) => {
            const next = stepIndex(activeIndex, matchCount, direction);

            setIndex(next);
            setPosition(next);
            setRevealKey((key) => key + 1);
        },
        [activeIndex, matchCount],
    );

    if (!isOpen) {
        return null;
    }

    const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
        setQuery(event.target.value);
        setIndex(0);
        setPosition(0);
        setRevealKey((key) => key + 1);
    };

    // Enter submits the form (next); Shift+Enter is the one key the form cannot tell apart. An Enter that commits an IME
    // candidate is text: it neither steps nor submits, and preventing it keeps the implicit form submit from firing.
    const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key !== "Enter") {
            return;
        }

        if (isImeKey(event.nativeEvent)) {
            event.preventDefault();

            return;
        }

        if (event.shiftKey) {
            event.preventDefault();
            step(-1);
        }
    };

    const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        step(1);
    };

    const hasQuery = deferredQuery.trim() !== "";
    let status = "";

    if (hasQuery) {
        status = matchCount > 0 ? t`${activeIndex + 1} of ${matchCount}` : t`No matches`;
    }

    return (
        <form
            aria-label={t`Find in side questions`}
            className="bg-popover text-popover-foreground sticky top-0 z-20 flex max-w-full items-center gap-1 rounded-lg border p-1 shadow-md"
            noValidate
            onSubmit={handleSubmit}
            ref={barRef}
            role="search"
        >
            <Input
                aria-label={t`Find in side questions`}
                autoComplete="off"
                className="min-w-0 grow"
                maxLength={MAX_FIND_QUERY_LENGTH}
                onChange={handleChange}
                onKeyDown={handleInputKeyDown}
                placeholder={t`Find in side questions`}
                ref={inputRef}
                size="sm"
                spellCheck={false}
                type="text"
                value={query}
            />
            <span aria-live="polite" className="text-muted-foreground min-w-16 px-1 text-center text-xs whitespace-nowrap tabular-nums" role="status">
                {status}
            </span>
            <TooltipIconButton disabled={matchCount === 0} onClick={() => step(-1)} tooltip={t`Previous match`} type="button">
                <ChevronUpIcon aria-hidden="true" className="size-4" />
            </TooltipIconButton>
            <TooltipIconButton disabled={matchCount === 0} onClick={() => step(1)} tooltip={t`Next match`} type="button">
                <ChevronDownIcon aria-hidden="true" className="size-4" />
            </TooltipIconButton>
            <TooltipIconButton onClick={close} tooltip={t`Close find`} type="button">
                <XIcon aria-hidden="true" className="size-4" />
            </TooltipIconButton>
        </form>
    );
};

AsideFindBar.displayName = "AsideFindBar";

export default AsideFindBar;
