"use client";

import { useLingui } from "@lingui/react/macro";
import { Input } from "@neore/ui/components/input";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import type { ChangeEvent, FC, FormEvent, KeyboardEvent } from "react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import TooltipIconButton from "@/features/chat/components/tooltip-icon-button";
import { useChatMessages, useChatThread } from "@/features/chat/core/context/chat-context";
import { FIND_IN_THREAD_EVENT } from "@/features/keyboard/lib/find-in-thread-target";

import { scrollToMessage } from "../message-list";
import { clampIndex, findMatches, MAX_FIND_QUERY_LENGTH, stepIndex } from "./match";
import useFindHighlights from "./use-find-highlights";

/**
 * Find in thread: a bar pinned to the top of the open thread. Matches come from the message data
 * (`match.ts`), so messages the list has not mounted count; the hit is scrolled to through the list's own
 * jump and painted by `use-find-highlights.ts`. Opened by the `findInThread` shortcut.
 */
/** Rows asked for per page while the search pulls in older messages. */
const FIND_PAGE_SIZE = 50;

const ThreadFindBar: FC = () => {
    const { t } = useLingui();
    const { loadMore, messages, messagesStatus } = useChatMessages();
    const { threadId } = useChatThread();
    const [isOpen, setIsOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [index, setIndex] = useState(0);
    // Bumped by every navigation, so stepping onto the same message scrolls back to it.
    const [revealKey, setRevealKey] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const barRef = useRef<HTMLFormElement>(null);
    const returnFocusRef = useRef<HTMLElement | null>(null);

    const deferredQuery = useDeferredValue(query);
    const matches = useMemo(() => (isOpen ? findMatches(messages, deferredQuery) : []), [isOpen, messages, deferredQuery]);
    const activeIndex = clampIndex(index, matches.length);
    const current = matches[activeIndex];
    const currentMessageId = current?.messageId;

    useFindHighlights(isOpen, deferredQuery, current, revealKey);

    // Matches come from loaded messages only, so a search reads the older pages in until the thread is exhausted.
    useEffect(() => {
        if (isOpen && deferredQuery.trim() !== "" && messagesStatus === "CanLoadMore") {
            loadMore(FIND_PAGE_SIZE);
        }
    }, [isOpen, deferredQuery, messagesStatus, loadMore]);

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

        globalThis.addEventListener(FIND_IN_THREAD_EVENT, open);

        return () => globalThis.removeEventListener(FIND_IN_THREAD_EVENT, open);
    }, []);

    useEffect(() => {
        if (isOpen && currentMessageId !== undefined) {
            // The bar keeps focus: the list would otherwise move it to the message.
            scrollToMessage(currentMessageId, { focus: false, threadId });
        }
    }, [isOpen, currentMessageId, revealKey, threadId]);

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
        const isReadingOlder = messagesStatus === "CanLoadMore" || messagesStatus === "LoadingMore";

        if (matches.length > 0) {
            status = t`${activeIndex + 1} of ${matches.length}`;
        } else {
            status = isReadingOlder ? t`Searching…` : t`No matches`;
        }
    }

    return (
        <form
            aria-label={t`Find in thread`}
            className="bg-popover text-popover-foreground absolute top-2 right-6 z-20 flex max-w-[calc(100%-2rem)] items-center gap-1 rounded-lg border p-1 shadow-md"
            noValidate
            onSubmit={handleSubmit}
            ref={barRef}
            role="search"
        >
            <Input
                aria-label={t`Find in thread`}
                autoComplete="off"
                className="w-44 sm:w-56"
                maxLength={MAX_FIND_QUERY_LENGTH}
                onChange={handleChange}
                onKeyDown={handleInputKeyDown}
                placeholder={t`Find in thread`}
                ref={inputRef}
                size="sm"
                spellCheck={false}
                type="text"
                value={query}
            />
            <span aria-live="polite" className="text-muted-foreground min-w-16 px-1 text-center text-xs whitespace-nowrap tabular-nums" role="status">
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

ThreadFindBar.displayName = "ThreadFindBar";

export default ThreadFindBar;
