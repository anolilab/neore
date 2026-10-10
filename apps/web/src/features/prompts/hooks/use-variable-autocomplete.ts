"use client";

import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PromptVariable, VariableItem, VariableMatch } from "../lib/prompt-variables";
import { formatVariable, getAllFilteredVariables, parseVariableMatch } from "../lib/prompt-variables";

// ============================================================================
// Types
// ============================================================================

export interface UseVariableAutocompleteOptions {
    /** Current cursor position */
    cursorPosition: number;
    /** Custom variables defined in the current prompt */
    customVariables?: PromptVariable[];
    /** Callback when text should be updated */
    onTextChange: (newText: string) => void;
    /** Optional search query (for CommandInput) */
    searchQuery?: string;
    /** Current text value */
    text: string;
}

export interface UseVariableAutocompleteReturn {
    /** Handle closing the menu (escape) */
    handleEscape: () => void;
    /** Handle keyboard navigation (call in keydown handler) */
    handleKeyDown: (event: KeyboardEvent | React.KeyboardEvent) => boolean;
    /** Handle selecting a variable */
    handleSelect: (variableName: string) => void;
    /** Handle value change from Command component */
    handleValueChange: (value: string) => void;
    /** Whether the autocomplete menu is open */
    isOpen: boolean;
    /** All filtered items for display */
    items: VariableItem[];
    /** Currently selected index */
    selectedIndex: number;
    /** Ref for tracking selectedIndex in closures */
    selectedIndexRef: React.RefObject<number>;
    /** Get the selected value for Command component */
    selectedValue: string | undefined;
    /** Set the selected index */
    setSelectedIndex: (index: number) => void;
    /** The current variable match (if any) */
    variableMatch: VariableMatch | undefined;
}

// ============================================================================
// Hook
// ============================================================================

export const useVariableAutocomplete = ({
    cursorPosition,
    customVariables = [],
    onTextChange,
    searchQuery = "",
    text,
}: UseVariableAutocompleteOptions): UseVariableAutocompleteReturn => {
    const { i18n } = useLingui();
    const [selectedIndex, setSelectedIndex] = useState(0);
    const selectedIndexRef = useRef(selectedIndex);

    // Keep ref in sync
    useEffect(() => {
        selectedIndexRef.current = selectedIndex;
    }, [selectedIndex]);

    // Parse variable match
    const variableMatch = useMemo(() => parseVariableMatch(text, cursorPosition), [text, cursorPosition]);

    // Get all filtered items (use searchQuery if available, otherwise use {{ query)
    const items = useMemo(() => {
        const queryToUse = searchQuery || variableMatch?.query || "";

        return getAllFilteredVariables(customVariables, queryToUse, i18n);
    }, [customVariables, i18n, variableMatch?.query, searchQuery]);

    const isOpen = variableMatch !== undefined && items.length > 0;

    // Keep the highlight in range as the filtered list shrinks. Adjusted during
    // render rather than in an effect so no stale index is ever painted.
    if (items.length > 0 && selectedIndex >= items.length) {
        setSelectedIndex(0);
    }

    // Replace variable pattern with selected variable
    const handleSelect = useCallback(
        (variableName: string) => {
            if (!variableMatch) {
                return;
            }

            const beforeVariable = text.slice(0, variableMatch.startIndex);
            const afterCursor = text.slice(cursorPosition);
            const newText = beforeVariable + formatVariable(variableName) + afterCursor;

            onTextChange(newText);
        },
        [variableMatch, text, cursorPosition, onTextChange],
    );

    // Close menu by removing {{
    const handleEscape = useCallback(() => {
        if (!variableMatch) {
            return;
        }

        const beforeVariable = text.slice(0, variableMatch.startIndex);
        const afterCursor = text.slice(cursorPosition);

        onTextChange(beforeVariable + afterCursor);
    }, [variableMatch, text, cursorPosition, onTextChange]);

    // Get selected value for Command component
    const selectedValue = useMemo(() => {
        if (items.length === 0 || selectedIndex < 0 || selectedIndex >= items.length) {
            return undefined;
        }

        return items[selectedIndex]?.name;
    }, [items, selectedIndex]);

    // Handle value change from Command
    const handleValueChange = useCallback(
        (value: string) => {
            const index = items.findIndex((item) => item.name === value);

            if (index !== -1) {
                setSelectedIndex(index);
            }
        },
        [items],
    );

    // Handle keyboard navigation
    const handleKeyDown = useCallback(
        (event: KeyboardEvent | React.KeyboardEvent): boolean => {
            if (!isOpen || items.length === 0) {
                return false;
            }

            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                event.stopPropagation();

                const currentIndex = selectedIndexRef.current;
                const newIndex = (currentIndex + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;

                setSelectedIndex(newIndex);

                return true;
            }

            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.stopPropagation();
                const currentIndex = selectedIndexRef.current;
                const selected = items[currentIndex];

                if (selected) {
                    handleSelect(selected.name);
                }

                return true;
            }

            if (event.key === "Tab" && !event.shiftKey) {
                event.preventDefault();
                event.stopPropagation();
                const currentIndex = selectedIndexRef.current;
                const selected = items[currentIndex];

                if (selected) {
                    handleSelect(selected.name);
                }

                return true;
            }

            if (event.key === "Escape" || event.key === "Esc") {
                event.preventDefault();
                event.stopPropagation();
                handleEscape();

                return true;
            }

            return false;
        },
        [isOpen, items, handleSelect, handleEscape],
    );

    return {
        handleEscape,
        handleKeyDown,
        handleSelect,
        handleValueChange,
        isOpen,
        items,
        selectedIndex,
        selectedIndexRef,
        selectedValue,
        setSelectedIndex,
        variableMatch,
    };
};

export { type VariableItem, type VariableMatch } from "../lib/prompt-variables";
