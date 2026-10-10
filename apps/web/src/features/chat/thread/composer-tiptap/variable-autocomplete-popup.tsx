"use client";

/**
 * VariableAutocompletePopup - Suggestion popup for {{variable}} patterns
 *
 * Shows variable suggestions when the user types `{{` in the tiptap editor.
 * Reuses the same variable data and categorization as the original implementation.
 */

import { useLingui } from "@lingui/react/macro";
import { Command, CommandEmpty, CommandGroup, CommandGroupLabel, CommandInput, CommandItem, CommandList, CommandSeparator } from "@neore/ui/components/command";
import clsx from "clsx";
import { Braces, MessageSquare, User } from "lucide-react";
import type { FC } from "react";
import { useCallback, useEffect, useEffectEvent, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import type { CommonVariableCategoryKey, PromptVariable, VariableItem } from "@/features/prompts/lib/prompt-variables";
import { COMMON_VARIABLE_CATEGORIES, formatVariable, getAllFilteredVariables } from "@/features/prompts/lib/prompt-variables";

import type { VariableAutocompleteMatch } from "./extensions/variable-autocomplete";

// ============================================================================
// Types
// ============================================================================

interface VariableAutocompletePopupProps {
    /** Custom variables defined in the current prompt */
    customVariables?: PromptVariable[];
    /** Rect of the editor element for positioning */
    editorRect: DOMRect | null;
    match: VariableAutocompleteMatch | null;
    /** Called to dismiss the popup */
    onDismiss: () => void;
    /** Called to replace the {{ text range in the editor with the full variable */
    onReplace: (from: number, to: number, replacement: string) => void;
}

const MENU_WIDTH = 320;

const CATEGORY_ICONS: Record<string, typeof Braces> = {
    conversation: MessageSquare,
    user: User,
};

// ============================================================================
// Main Component
// ============================================================================

const EMPTY_CUSTOM_VARIABLES: PromptVariable[] = [];

const VariableAutocompletePopup: FC<VariableAutocompletePopupProps> = ({
    customVariables = EMPTY_CUSTOM_VARIABLES,
    editorRect,
    match,
    onDismiss,
    onReplace,
}) => {
    const { i18n, t } = useLingui();
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [searchQuery, setSearchQuery] = useState("");

    // Get filtered variables
    const items = useMemo(() => {
        const queryToUse = searchQuery || match?.query || "";

        return getAllFilteredVariables(customVariables, queryToUse, i18n);
    }, [customVariables, i18n, match?.query, searchQuery]);

    const isOpen = match !== null && items.length > 0;

    // Both resets are derived from render inputs, so they are adjusted during
    // render rather than in an effect — one commit instead of two.
    const [previousInputs, setPreviousInputs] = useState<{ itemCount: number; match: typeof match } | undefined>(undefined);

    if (items.length !== previousInputs?.itemCount || match !== previousInputs.match) {
        setPreviousInputs({ itemCount: items.length, match });

        if (items.length !== previousInputs?.itemCount) {
            setSelectedIndex(0);
        }

        if (!match) {
            setSearchQuery("");
        }
    }

    // Handle variable selection
    const handleSelect = useCallback(
        (variableName: string) => {
            if (!match) {
                return;
            }

            // Check if there's a closing }} after the cursor in the full document
            // For simplicity, we replace from {{ to cursor with the full {{variable}}
            const replacement = formatVariable(variableName);

            onReplace(match.from, match.to, replacement);
            setSearchQuery("");
            onDismiss();
        },
        [match, onReplace, onDismiss],
    );

    // Keyboard navigation. The handler body is an Effect Event so the listener is
    // attached once per open/close instead of being torn down and re-attached on
    // every keystroke (`items`/`selectedIndex` change constantly while typing).
    const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
        if (event.key === "ArrowDown") {
            event.preventDefault();
            event.stopPropagation();
            setSelectedIndex((previous) => (previous + 1) % items.length);
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            event.stopPropagation();
            setSelectedIndex((previous) => (previous - 1 + items.length) % items.length);
        } else if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
            event.preventDefault();
            event.stopPropagation();
            const selected = items[selectedIndex];

            if (selected) {
                handleSelect(selected.name);
            }
        } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onDismiss();
        }
    });

    useEffect(() => {
        if (!isOpen) {
            return undefined;
        }

        const handleKeyDown = (event: KeyboardEvent) => onKeyDown(event);

        globalThis.addEventListener("keydown", handleKeyDown, { capture: true });

        return () => globalThis.removeEventListener("keydown", handleKeyDown, true);
    }, [isOpen]);

    // Group items by category. Must stay above the early return below — a hook
    // that only runs when the popup is open changes the hook order between renders.
    const groupedItems = useMemo(() => {
        const groups: Record<string, VariableItem[]> = {};

        for (const item of items) {
            if (!Object.hasOwn(groups, item.category)) {
                groups[item.category] = [];
            }

            groups[item.category]!.push(item);
        }

        return groups;
    }, [items]);

    if (!isOpen || !editorRect) {
        return null;
    }

    const customGroup = groupedItems.custom ?? [];
    const categoryGroups = Object.entries(groupedItems).flatMap(([key, categoryItems]) => {
        if (key === "custom" || categoryItems.length === 0) {
            return [];
        }

        return [
            {
                icon: CATEGORY_ICONS[key] ?? Braces,
                key,
                label: Object.hasOwn(COMMON_VARIABLE_CATEGORIES, key) ? i18n._(COMMON_VARIABLE_CATEGORIES[key as CommonVariableCategoryKey].description) : key,
                variables: categoryItems,
            },
        ];
    });

    const position = {
        left: editorRect.left,
        top: editorRect.top,
    };

    // Calculate flat index for highlighting
    const getItemIndex = (category: string, itemIndex: number): number => {
        if (category === "custom") {
            return itemIndex;
        }

        let index = 0;

        index += customGroup.length;

        for (const group of categoryGroups) {
            if (group.key === category) {
                return index + itemIndex;
            }

            index += group.variables.length;
        }

        return index;
    };

    return createPortal(
        <div
            className="fixed z-50"
            style={{
                left: `${position.left}px`,
                top: `${position.top}px`,
                transform: "translateY(-100%)",
            }}
        >
            <div
                className={clsx(
                    "overflow-hidden rounded-lg border",
                    "bg-popover text-popover-foreground",
                    "dark:bg-[oklch(0.205_0_0)] dark:text-[oklch(0.985_0_0)]",
                    "border-border dark:border-white/10",
                    "shadow-md dark:shadow-xl dark:shadow-black/50",
                    "ring-foreground/10 ring-1 dark:ring-white/10",
                    "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2",
                )}
                style={{ width: MENU_WIDTH }}
            >
                <Command>
                    <CommandInput onChange={(e) => setSearchQuery(e.target.value)} placeholder={t`Search variables...`} value={searchQuery} />
                    <CommandList className="max-h-[300px]">
                        {items.length === 0 && (
                            <CommandEmpty>
                                <div className="flex flex-col items-center gap-2 py-6">
                                    <Braces className="text-muted-foreground size-8" />
                                    <p className="text-muted-foreground text-sm">{t`No variables found`}</p>
                                </div>
                            </CommandEmpty>
                        )}

                        {customGroup.length > 0 && (
                            <CommandGroup>
                                <CommandGroupLabel>{t`Prompt Variables`}</CommandGroupLabel>
                                {customGroup.map((variable, i) => (
                                    <CommandItem
                                        className={clsx("transition-colors", getItemIndex("custom", i) === selectedIndex && "bg-accent text-accent-foreground")}
                                        key={variable.name}
                                        onClick={(e) => {
                                            e.preventDefault();
                                            handleSelect(variable.name);
                                        }}
                                        value={variable.name}
                                    >
                                        <code className="text-primary shrink-0 font-mono text-sm">{`{{${variable.name}}}`}</code>
                                        {variable.description && <span className="text-muted-foreground ml-2 truncate text-xs">{variable.description}</span>}
                                    </CommandItem>
                                ))}
                            </CommandGroup>
                        )}

                        {customGroup.length > 0 && categoryGroups.length > 0 && <CommandSeparator />}

                        {categoryGroups.map((category) => {
                            const Icon = category.icon;

                            return (
                                <CommandGroup key={category.key}>
                                    <CommandGroupLabel className="flex items-center gap-1.5">
                                        <Icon className="size-3.5" />
                                        {category.label}
                                    </CommandGroupLabel>
                                    {category.variables.map((variable, i) => (
                                        <CommandItem
                                            className={clsx(
                                                "transition-colors",
                                                getItemIndex(category.key, i) === selectedIndex && "bg-accent text-accent-foreground",
                                            )}
                                            key={variable.name}
                                            onClick={(e) => {
                                                e.preventDefault();
                                                handleSelect(variable.name);
                                            }}
                                            value={variable.name}
                                        >
                                            <code className="text-primary shrink-0 font-mono text-sm">{`{{${variable.name}}}`}</code>
                                            {variable.description && (
                                                <span className="text-muted-foreground ml-2 truncate text-xs">{variable.description}</span>
                                            )}
                                        </CommandItem>
                                    ))}
                                </CommandGroup>
                            );
                        })}
                    </CommandList>
                </Command>
            </div>
        </div>,
        document.body,
    );
};

export default VariableAutocompletePopup;
