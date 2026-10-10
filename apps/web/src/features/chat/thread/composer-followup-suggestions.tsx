/**
 * ComposerFollowupSuggestions - Follow-up suggestions for the composer
 *
 * Fetches suggestions via action which returns cached suggestions from DB
 * or generates new ones if needed.
 */
import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import cn from "@neore/ui/utils/cn";
import { useMutation } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ChevronDown, PlusIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { FC } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useChatIsRunning, useChatMessages, useChatThread } from "@/features/chat/core/context/chat-context";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { getValidThreadId } from "@/features/chat/core/utils/thread-id";
import usePromptImprovementStore from "@/features/chat/prompt-improvement/stores/prompt-improvement-store";
import { useLunoraActionOptions } from "@/lib/lunora/crpc";

("use client");

const FETCH_TIMEOUT_MS = 30_000;

const ComposerFollowupSuggestions: FC = () => {
    const { t } = useLingui();
    const { threadId } = useChatThread();
    const { messages } = useChatMessages();
    const isRunning = useChatIsRunning();
    // Booleans, so typing does not re-render the suggestions on every keystroke.
    const hasComposerText = useChatUIStore((state) => state.composerText.trim().length > 0);
    const isComposerEmpty = useChatUIStore((state) => state.composerText === "");
    const setComposerText = useChatUIStore((state) => state.setComposerText);
    const isAtBottom = useChatUIStore((state) => state.isAtBottom);
    const isPromptImprovementOpen = usePromptImprovementStore((state) => state.isOpen);

    const validThreadId = getValidThreadId(threadId);

    // Use action to fetch suggestions - handles caching internally
    const { mutateAsync: getFollowupSuggestions } = useMutation(useLunoraActionOptions(api.chat.functions.getFollowupSuggestions));

    const [suggestions, setSuggestions] = useState<string[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isOpen, setIsOpen] = useState(false);
    const isFirstLoadRef = useRef(true);
    const previousSuggestionsRef = useRef<string[]>([]);
    const userManuallyClosedRef = useRef(false);
    const userManuallyOpenedRef = useRef(false);
    const previousThreadIdRef = useRef<string | undefined>(undefined);
    const isFetchingRef = useRef(false);

    const lastMessage = messages.length > 0 ? messages.at(-1) : null;
    const lastMessageRole = useMemo(() => lastMessage?.role, [lastMessage]);

    const hasUserMessage = useMemo(() => messages.some((message) => message.role === "user"), [messages]);

    // Conditions for when we should show/fetch suggestions
    const shouldFetchConditions = useMemo(
        () => validThreadId && !isRunning && messages.length > 0 && lastMessage && lastMessageRole === "assistant" && hasUserMessage,
        [validThreadId, isRunning, messages.length, lastMessage, lastMessageRole, hasUserMessage],
    );

    // Determine if we should show the suggestions
    const shouldShow = shouldFetchConditions && suggestions.length > 0;

    // Reset state when thread changes
    useEffect(() => {
        if (previousThreadIdRef.current === threadId) {
            return;
        }

        previousThreadIdRef.current = threadId;
        isFirstLoadRef.current = true;
        userManuallyClosedRef.current = false;
        userManuallyOpenedRef.current = false;
        previousSuggestionsRef.current = [];
        setSuggestions([]);
        setIsOpen(false);
    }, [threadId]);

    // Fetch suggestions via action when conditions are met
    useEffect(() => {
        if (!shouldFetchConditions || !validThreadId) {
            return;
        }

        // If we already have suggestions, don't fetch
        if (suggestions.length > 0) {
            return;
        }

        // If already fetching, skip
        if (isFetchingRef.current) {
            return;
        }

        isFetchingRef.current = true;
        setIsLoading(true);

        let timeoutId: ReturnType<typeof setTimeout> | undefined;

        const timeoutPromise = new Promise<never>((_resolve, reject) => {
            timeoutId = setTimeout(() => {
                reject(new Error("Request timeout: suggestions took too long to generate"));
            }, FETCH_TIMEOUT_MS);
        });

        const fetchPromise = getFollowupSuggestions({ threadId: validThreadId });

        Promise.race([fetchPromise, timeoutPromise])
            .then((result) => {
                const newSuggestions = result?.suggestions || [];

                clearTimeout(timeoutId);
                setSuggestions(newSuggestions);
                setIsLoading(false);
                isFetchingRef.current = false;

                return undefined;
            })
            .catch((error) => {
                clearTimeout(timeoutId);
                console.error("[ComposerFollowupSuggestions] Error fetching suggestions:", error);
                setSuggestions([]);
                setIsLoading(false);
                isFetchingRef.current = false;
            });
    }, [shouldFetchConditions, validThreadId, suggestions.length, getFollowupSuggestions]);

    // Handle new suggestions arriving
    useEffect(() => {
        if (!shouldShow) {
            if (isOpen && !isLoading) {
                setIsOpen(false);
            }

            return;
        }

        const isFirstLoad = isFirstLoadRef.current;
        const hasText = hasComposerText;
        const isSuggestionsChanged = previousSuggestionsRef.current.length === 0 || previousSuggestionsRef.current.join("|") !== suggestions.join("|");

        if (isSuggestionsChanged) {
            previousSuggestionsRef.current = suggestions;

            if (suggestions.length > 0) {
                userManuallyClosedRef.current = false;
                userManuallyOpenedRef.current = false;

                if (isFirstLoad && !hasText) {
                    setIsOpen(true);
                    isFirstLoadRef.current = false;
                } else if (isFirstLoad) {
                    isFirstLoadRef.current = false;
                }
            }
        }
    }, [shouldShow, suggestions, hasComposerText, isOpen, isLoading]);

    const handleClick = useCallback(
        (suggestion: string) => {
            setComposerText(suggestion);
            userManuallyClosedRef.current = true;
            userManuallyOpenedRef.current = false;
            setIsOpen(false);
        },
        [setComposerText],
    );

    const toggleOpen = useCallback(() => {
        const isNewState = !isOpen;

        userManuallyOpenedRef.current = isNewState;
        userManuallyClosedRef.current = !isNewState;

        setIsOpen(isNewState);
    }, [isOpen]);

    // Auto close/open based on scroll position and composer text
    // Note: We use functional update to avoid isOpen in dependencies (prevents infinite loop)
    useEffect(() => {
        const wasManuallyOpened = userManuallyOpenedRef.current;
        const wasManuallyClosed = userManuallyClosedRef.current;
        const hasText = hasComposerText;

        setIsOpen((currentIsOpen) => {
            if (hasText && currentIsOpen && !wasManuallyOpened) {
                return false;
            }

            if (!isAtBottom && currentIsOpen && !wasManuallyOpened) {
                return false;
            }

            if (isAtBottom && !currentIsOpen && suggestions.length > 0 && !hasText && !wasManuallyClosed) {
                return true;
            }

            return currentIsOpen;
        });
    }, [isAtBottom, suggestions.length, hasComposerText]);

    // Re-open when composer text is cleared
    useEffect(() => {
        if (!(isComposerEmpty && suggestions.length > 0)) {
            return;
        }

        userManuallyClosedRef.current = false;

        if (isAtBottom) {
            setIsOpen(true);
        }
    }, [isComposerEmpty, suggestions.length, isAtBottom]);

    if (isLoading || !shouldShow || isPromptImprovementOpen) {
        return null;
    }

    return (
        <div className="relative">
            <motion.div
                animate={{
                    paddingBottom: isOpen ? "1rem" : "0.375rem",
                }}
                className={clsx("absolute right-0 bottom-0 left-0 -mb-2 overflow-hidden rounded-t-lg pl-1.5", suggestions.length < 4 && "pr-1.5")}
                initial={false}
                transition={{ duration: 0.3, ease: "easeOut" }}
            >
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <button
                                aria-expanded={isOpen}
                                aria-label={isOpen ? t`Hide follow-up suggestions` : t`Show follow-up suggestions`}
                                className="group focus-visible:ring-ring/50 relative flex w-full cursor-pointer items-center py-1 transition-colors outline-none focus-visible:ring-1"
                                onClick={toggleOpen}
                                type="button"
                            >
                                <div
                                    className={cn(
                                        "text-muted-foreground group-hover:text-foreground mx-auto size-4 shrink-0 transition-transform duration-300 ease-in-out",
                                        !isOpen && "rotate-180",
                                    )}
                                >
                                    <ChevronDown className="size-4" />
                                </div>
                            </button>
                        }
                    />
                    <TooltipContent side="top">{isOpen ? t`Hide follow-up suggestions` : t`Show follow-up suggestions`}</TooltipContent>
                </Tooltip>
                <AnimatePresence>
                    {isOpen && (
                        <motion.div
                            animate={{ height: "auto", opacity: 1 }}
                            className="w-full overflow-hidden"
                            exit={{ height: 0, opacity: 0 }}
                            initial={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.3, ease: "easeOut" }}
                        >
                            <motion.div
                                animate={{ opacity: 1 }}
                                className="flex flex-wrap gap-2 px-2 pb-1"
                                initial={{ opacity: 0 }}
                                key={suggestions.join("|")}
                                transition={{ duration: 0.2 }}
                            >
                                {suggestions.map((suggestion, index) => (
                                    <motion.button
                                        animate={{ opacity: 1, y: 0 }}
                                        className={cn(
                                            "group flex max-w-xs cursor-pointer items-center gap-1.5 rounded-2xl border px-3 py-1.5 text-left text-sm transition-all outline-none",
                                            "border-border/60 bg-muted/50 hover:bg-muted hover:border-border",
                                            "focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-1",
                                            "active:scale-[0.98]",
                                        )}
                                        initial={{ opacity: 0, y: 6 }}
                                        key={suggestion}
                                        onClick={() => handleClick(suggestion)}
                                        transition={{ delay: index * 0.04, duration: 0.2 }}
                                        type="button"
                                    >
                                        <PlusIcon className="text-muted-foreground size-3 shrink-0 opacity-60" />
                                        <span className="text-foreground truncate leading-snug transition-colors">{suggestion}</span>
                                    </motion.button>
                                ))}
                            </motion.div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </motion.div>
        </div>
    );
};

export default ComposerFollowupSuggestions;
