"use client";

import { useLingui } from "@lingui/react/macro";
import { Input } from "@neore/ui/components/input";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import type { ChangeEvent, FC, FormEvent, KeyboardEvent } from "react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import TooltipIconButton from "@/features/chat/components/tooltip-icon-button";
import { clampIndex, findMatches, MAX_FIND_QUERY_LENGTH, stepIndex } from "@/features/chat/thread/find/match";
import { ASIDE_FIND_EVENT } from "@/features/keyboard/lib/aside-find-target";

import type { AsideEntry } from "../aside-store";
import { asideFindMessages } from "./aside-find";
import useAsideFindHighlights from "./use-aside-find-highlights";

/**
 * Find in the side questions: a bar at the top of the panel that searches the questions and answers in it and
 * paints the hits. Opened by the Find shortcut while focus is in the panel (`keyboard-shortcuts-manager.tsx`).
 * The matching is the thread find's (`thread/find/match.ts`), run over the panel's own entries.
 */
const AsideFindBar: FC<{ entries: ReadonlyArray<AsideEntry> }> = ({ entries }) => {
    const { t } = useLingui();
    const [isOpen, setIsOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [index, setIndex] = useState(0);
    // Bumped by every navigation, so stepping onto the same entry scrolls back to it.
    const [revealKey, setRevealKey] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const barRef = useRef<HTMLFormElement>(null);
    const returnFocusRef = useRef<HTMLElement | null>(null);

    const deferredQuery = useDeferredValue(query);
    const messages = useMemo(() => asideFindMessages(entries), [entries]);
    const matches = useMemo(() => (isOpen ? findMatches(messages, deferredQuery) : []), [isOpen, messages, deferredQuery]);
    const activeIndex = clampIndex(index, matches.length);
    const current = matches[activeIndex];

    useAsideFindHighlights(barRef, isOpen, deferredQuery, current, revealKey);

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
            if (event.key !== "Escape") {
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
            setIndex(stepIndex(activeIndex, matches.length, direction));
            setRevealKey((key) => key + 1);
        },
        [activeIndex, matches.length],
    );

    if (!isOpen) {
        return null;
    }

    const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
        setQuery(event.target.value);
        setIndex(0);
        setRevealKey((key) => key + 1);
    };

    // Enter submits the form (next); Shift+Enter is the one key the form cannot tell apart.
    const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (!(event.key === "Enter" && event.shiftKey)) {
            return;
        }

        event.preventDefault();
        step(-1);
    };

    const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        step(1);
    };

    const hasQuery = deferredQuery.trim() !== "";
    let status = "";

    if (hasQuery) {
        status = matches.length > 0 ? t`${activeIndex + 1} of ${matches.length}` : t`No matches`;
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
            <span aria-live="polite" className="text-muted-foreground min-w-16 px-1 text-center text-xs tabular-nums" role="status">
                {status}
            </span>
            <TooltipIconButton disabled={matches.length === 0} onClick={() => step(-1)} tooltip={t`Previous match`} type="button">
                <ChevronUpIcon aria-hidden="true" className="size-4" />
            </TooltipIconButton>
            <TooltipIconButton disabled={matches.length === 0} onClick={() => step(1)} tooltip={t`Next match`} type="button">
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
