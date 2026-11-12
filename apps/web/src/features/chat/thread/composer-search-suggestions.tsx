"use client";

/**
 * ComposerSearchSuggestions - Inline query suggestions while typing
 *
 * Shows search refinement suggestions below the composer when the user
 * is actively typing in a search mode (not chat/writing).
 * Uses local pattern-based heuristics — no API call needed.
 */

import { useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import { AnimatePresence, motion } from "motion/react";
import type { FC } from "react";
import { useEffect, useState } from "react";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { useModelStore } from "@/features/chat/core/stores/model-store";

import type { SearchMode, SearchSuggestion } from "./search-suggestions";
import generateSearchSuggestions from "./search-suggestions";

const DEBOUNCE_MS = 200;

const ComposerSearchSuggestions: FC = () => {
    const { t } = useLingui();
    const setComposerText = useChatUIStore((state) => state.setComposerText);
    const searchMode = useModelStore((state) => state.searchMode) as SearchMode;
    const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);

    // Debounced suggestion generation. The draft is followed through a store subscription, not a selector: this re-renders
    // when the suggestions change, not on every keystroke.
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const schedule = (text: string) => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                setSuggestions(generateSearchSuggestions(text, searchMode));
            }, DEBOUNCE_MS);
        };

        schedule(useChatUIStore.getState().composerText);

        const unsubscribe = useChatUIStore.subscribe((state, previous) => {
            if (state.composerText !== previous.composerText) {
                schedule(state.composerText);
            }
        });

        return () => {
            unsubscribe();
            clearTimeout(timer);
        };
    }, [searchMode]);

    const handleSuggestionClick = (suggestion: SearchSuggestion) => {
        setComposerText(suggestion.text);
        setSuggestions([]);
    };

    // Don't render in non-search modes
    const isSearchMode = searchMode !== "chat" && searchMode !== "writing";

    if (!isSearchMode || suggestions.length === 0) {
        return null;
    }

    return (
        <AnimatePresence>
            <motion.div
                animate={{ opacity: 1, y: 0 }}
                aria-label={t`Search suggestions`}
                className="flex flex-wrap gap-1.5 px-3 pb-2"
                exit={{ opacity: 0, y: 4 }}
                initial={{ opacity: 0, y: 4 }}
                role="group"
                transition={{ duration: 0.15 }}
            >
                {suggestions.map((suggestion) => (
                    <button
                        className={cn(
                            "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                            "border-border/50 bg-muted/30 text-muted-foreground hover:bg-muted hover:text-foreground",
                            suggestion.type === "operator" && "border-blue-500/30 text-blue-600 dark:text-blue-400",
                        )}
                        key={suggestion.text}
                        onClick={() => handleSuggestionClick(suggestion)}
                        type="button"
                    >
                        {suggestion.type === "operator" && (
                            <span aria-hidden="true" className="font-mono text-[10px] opacity-60">
                                op
                            </span>
                        )}
                        <span className="max-w-[200px] truncate">{suggestion.text}</span>
                    </button>
                ))}
            </motion.div>
        </AnimatePresence>
    );
};

export default ComposerSearchSuggestions;
