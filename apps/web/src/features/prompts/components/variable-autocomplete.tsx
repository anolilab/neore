"use client";

import { useLingui } from "@lingui/react/macro";
import { Command, CommandEmpty, CommandGroup, CommandGroupLabel, CommandInput, CommandItem, CommandList, CommandSeparator } from "@neore/ui/components/command";
import clsx from "clsx";
import { Braces, MessageSquare, User } from "lucide-react";
import type { JSX, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import useCursorPosition from "../hooks/use-cursor-position";
import type { CommonVariableCategoryKey, PromptVariable } from "../lib/prompt-variables";
import { COMMON_VARIABLE_CATEGORIES, formatVariable, getAllFilteredVariables, parseVariableMatch } from "../lib/prompt-variables";

interface VariableAutocompleteProps {
    /** Child element (textarea or input wrapper) */
    children: ReactNode;
    /** Custom variables defined in the current prompt */
    customVariables?: PromptVariable[];
    /** When true, the variable autocomplete menu will not appear */
    disabled?: boolean;
    /** Selector for the input element to monitor */
    inputSelector: string;
    /** Callback when text should be updated */
    onTextChange: (newText: string) => void;
    /** Current text value */
    text: string;
}

interface MenuPosition {
    left: number;
    top: number;
}

/** The composer input the menu anchors to — a `<textarea>` or `<input>`, or nothing if it is not mounted yet. */
type AnchorInput = HTMLInputElement | HTMLTextAreaElement | null;

const EMPTY_CUSTOM_VARIABLES: PromptVariable[] = [];

const MENU_WIDTH = { width: 320 };

const CATEGORY_ICONS: Record<string, typeof Braces> = {
    conversation: MessageSquare,
    user: User,
};

const useMenuPosition = (isOpen: boolean, inputSelector: string): MenuPosition | null => {
    const [position, setPosition] = useState<MenuPosition | null>(null);

    useEffect(() => {
        if (!isOpen) {
            setPosition(null);

            return undefined;
        }

        const updatePosition = () => {
            const input = document.querySelector(inputSelector) as AnchorInput;

            if (!input) {
                return;
            }

            const rect = input.getBoundingClientRect();

            setPosition({
                left: rect.left,
                top: rect.top,
            });
        };

        updatePosition();

        window.addEventListener("resize", updatePosition);
        window.addEventListener("scroll", updatePosition, { capture: true });

        return () => {
            window.removeEventListener("resize", updatePosition);
            window.removeEventListener("scroll", updatePosition, true);
        };
    }, [isOpen, inputSelector]);

    return position;
};

interface VariableListProps {
    items: { category: string; description?: string; name: string }[];
    onSelect: (variableName: string) => void;
    query: string;
}

const VariableList = ({ items, onSelect, query }: VariableListProps): JSX.Element => {
    const { i18n, t } = useLingui();

    const buildGroupedItems = () => {
        const groups: Record<string, { category: string; description?: string; name: string }[]> = {};

        for (const item of items) {
            const { category } = item;

            if (!Object.hasOwn(groups, category)) {
                groups[category] = [];
            }

            groups[category]!.push(item);
        }

        return groups;
    };

    const groupedItems = buildGroupedItems();
    const filteredCustom = groupedItems.custom ?? [];

    const filteredCategories = Object.entries(groupedItems).flatMap(([key, categoryItems]) => {
        if (key === "custom" || categoryItems.length === 0) {
            return [];
        }

        return [
            {
                icon: CATEGORY_ICONS[key] ?? Braces,
                key,
                variables: categoryItems,
            },
        ];
    });

    const hasResults = filteredCustom.length > 0 || filteredCategories.length > 0;

    if (!hasResults) {
        return (
            <CommandEmpty>
                <div className="flex flex-col items-center gap-2 py-6">
                    <Braces className="text-muted-foreground size-8" />
                    <p className="text-muted-foreground text-sm">{t`No variables found`}</p>
                    {query && <p className="text-muted-foreground/70 text-xs">{t`Create a custom variable by typing the full name`}</p>}
                </div>
            </CommandEmpty>
        );
    }

    return (
        <>
            {filteredCustom.length > 0 && (
                <CommandGroup>
                    <CommandGroupLabel>{t`Prompt Variables`}</CommandGroupLabel>
                    {filteredCustom.map((variable) => (
                        <CommandItem
                            className={clsx(
                                "transition-colors",
                                "data-selected:bg-accent data-selected:text-accent-foreground",
                                "data-highlighted:bg-accent data-highlighted:text-accent-foreground",
                                "hover:bg-accent/50 dark:hover:bg-accent/30",
                            )}
                            key={variable.name}
                            onClick={(e) => {
                                e.preventDefault();
                                onSelect(variable.name);
                            }}
                            value={variable.name}
                        >
                            <code className="text-primary shrink-0 font-mono text-sm">{`{{${variable.name}}}`}</code>
                            {variable.description && (
                                <span className="text-muted-foreground data-highlighted:text-accent-foreground/70 ml-2 truncate text-xs">
                                    {variable.description}
                                </span>
                            )}
                        </CommandItem>
                    ))}
                </CommandGroup>
            )}

            {filteredCustom.length > 0 && filteredCategories.length > 0 && <CommandSeparator />}

            {filteredCategories.map((category) => {
                const Icon = category.icon;
                const categoryData = Object.hasOwn(COMMON_VARIABLE_CATEGORIES, category.key)
                    ? COMMON_VARIABLE_CATEGORIES[category.key as CommonVariableCategoryKey]
                    : undefined;

                return (
                    <CommandGroup key={category.key}>
                        <CommandGroupLabel className="flex items-center gap-1.5">
                            <Icon className="size-3.5" />
                            {categoryData ? i18n._(categoryData.description) : category.key}
                        </CommandGroupLabel>
                        {category.variables.map((variable) => (
                            <CommandItem
                                className={clsx(
                                    "transition-colors",
                                    "data-selected:bg-accent data-selected:text-accent-foreground",
                                    "data-highlighted:bg-accent data-highlighted:text-accent-foreground",
                                    "hover:bg-accent/50 dark:hover:bg-accent/30",
                                )}
                                key={variable.name}
                                onClick={(e) => {
                                    e.preventDefault();
                                    onSelect(variable.name);
                                }}
                                value={variable.name}
                            >
                                <code className="text-primary shrink-0 font-mono text-sm">{`{{${variable.name}}}`}</code>
                                {variable.description && (
                                    <span className="text-muted-foreground data-highlighted:text-accent-foreground/70 ml-2 truncate text-xs">
                                        {variable.description}
                                    </span>
                                )}
                            </CommandItem>
                        ))}
                    </CommandGroup>
                );
            })}
        </>
    );
};

interface VariableMenuProps {
    commandListRef: RefObject<HTMLDivElement | null>;
    items: { category: string; description?: string; name: string }[];
    onSearchChange: (search: string) => void;
    onSelect: (variableName: string) => void;
    onValueChange: (value: string) => void;
    position: MenuPosition;
    query: string;
    searchQuery: string;
    selectedValue: string | undefined;
}

const VariableMenu = ({
    commandListRef,
    items,
    onSearchChange,
    onSelect,
    onValueChange,
    position,
    query,
    searchQuery,
    selectedValue,
}: VariableMenuProps): JSX.Element => {
    const { t } = useLingui();

    const menuContent = (
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
                style={MENU_WIDTH}
            >
                <Command onValueChange={onValueChange} value={selectedValue}>
                    <CommandInput onChange={(e) => onSearchChange(e.target.value)} placeholder={t`Search variables...`} value={searchQuery} />
                    <div className="outline-none" ref={commandListRef} tabIndex={-1}>
                        <CommandList className="max-h-[300px]">
                            <VariableList items={items} onSelect={onSelect} query={query} />
                        </CommandList>
                    </div>
                </Command>
            </div>
        </div>
    );

    return createPortal(menuContent, document.body);
};

const VariableAutocomplete = ({
    children,
    customVariables = EMPTY_CUSTOM_VARIABLES,
    disabled = false,
    inputSelector,
    onTextChange,
    text,
}: VariableAutocompleteProps): JSX.Element => {
    const { i18n } = useLingui();
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [searchQuery, setSearchQuery] = useState("");
    const commandListRef = useRef<HTMLDivElement | null>(null);
    const selectedIndexRef = useRef(selectedIndex);
    const handleKeyDownRef = useRef<((event: KeyboardEvent) => void) | null>(null);
    const handleSelectVariableRef = useRef<((variableName: string) => void) | null>(null);
    const handleEscapeRef = useRef<(() => void) | null>(null);
    const restoreFocusRef = useRef<(() => void) | null>(null);

    useEffect(() => {
        selectedIndexRef.current = selectedIndex;
    }, [selectedIndex]);

    const cursorPosition = useCursorPosition(inputSelector);

    const variableMatch = useMemo(() => parseVariableMatch(text, cursorPosition), [text, cursorPosition]);

    // Clearing the query is derived from the parsed match, so it is adjusted during
    // render rather than in an effect.
    const [previousInputs, setPreviousInputs] = useState<{ cursorPosition: number; text: string }>();

    if (text !== previousInputs?.text || cursorPosition !== previousInputs.cursorPosition) {
        setPreviousInputs({ cursorPosition, text });

        if (!variableMatch) {
            setSearchQuery("");
        }
    }

    const items = useMemo(() => {
        const queryToUse = searchQuery || variableMatch?.query || "";

        return getAllFilteredVariables(customVariables, queryToUse, i18n);
    }, [customVariables, i18n, variableMatch?.query, searchQuery]);

    const isOpen = !disabled && variableMatch !== undefined && items.length > 0;
    const menuPosition = useMenuPosition(isOpen, inputSelector);

    // Keep the highlight in range as the filtered list shrinks. Adjusted during
    // render rather than in an effect so no stale index is ever painted.
    if (items.length > 0 && selectedIndex >= items.length) {
        setSelectedIndex(0);
    }

    useEffect(() => {
        if (!isOpen || items.length === 0) {
            return undefined;
        }

        const timeoutId = setTimeout(() => {
            const commandList = commandListRef.current?.querySelector('[data-slot="command-list"]') as HTMLElement;

            if (commandList) {
                const commandItems = commandList.querySelectorAll('[data-slot="command-item"]') as NodeListOf<HTMLElement>;

                if (commandItems.length > 0 && commandItems[0]) {
                    commandItems[0].dataset.highlighted = "";
                }
            }
        }, 0);

        return () => clearTimeout(timeoutId);
    }, [isOpen, items.length]);

    // Replace variable pattern with selected variable
    const replaceVariable = useCallback(
        (variableName: string) => {
            if (!variableMatch) {
                return;
            }

            const afterCursor = text.slice(cursorPosition);
            const closingIndex = afterCursor.indexOf("}}");

            const endIndex = closingIndex === -1 ? cursorPosition : cursorPosition + closingIndex + 2;

            const beforeVariable = text.slice(0, variableMatch.startIndex);
            const afterVariable = text.slice(endIndex);
            const formattedVariable = formatVariable(variableName);
            const newText = beforeVariable + formattedVariable + afterVariable;
            const newCursorPosition = variableMatch.startIndex + formattedVariable.length;

            onTextChange(newText);

            requestAnimationFrame(() => {
                const input = document.querySelector(inputSelector) as AnchorInput;

                if (input) {
                    input.setSelectionRange(newCursorPosition, newCursorPosition);
                    input.focus();
                }
            });
        },
        [variableMatch, text, cursorPosition, onTextChange, inputSelector],
    );

    const restoreFocus = useCallback(() => {
        requestAnimationFrame(() => {
            const input = document.querySelector(inputSelector) as AnchorInput;

            if (input) {
                input.focus();
            }
        });
    }, [inputSelector]);

    const handleSelectVariable = useCallback(
        (variableName: string) => {
            replaceVariable(variableName);
            setSearchQuery("");
            setSelectedIndex(0);
            restoreFocus();
        },
        [replaceVariable, restoreFocus],
    );

    const handleEscape = useCallback(() => {
        if (!variableMatch) {
            return;
        }

        const beforeVariable = text.slice(0, variableMatch.startIndex);
        const afterCursor = text.slice(cursorPosition);

        onTextChange(beforeVariable + afterCursor);
    }, [variableMatch, text, cursorPosition, onTextChange]);

    useEffect(() => {
        handleSelectVariableRef.current = handleSelectVariable;
        handleEscapeRef.current = handleEscape;
        restoreFocusRef.current = restoreFocus;
    }, [handleSelectVariable, handleEscape, restoreFocus]);

    const selectedValue = useMemo(() => {
        if (items.length === 0 || selectedIndex < 0 || selectedIndex >= items.length) {
            return undefined;
        }

        const selected = items[selectedIndex];

        return selected?.name;
    }, [items, selectedIndex]);

    const handleValueChange = useCallback(
        (value: string) => {
            const index = items.findIndex((item) => item.name === value);

            if (index !== -1) {
                setSelectedIndex(index);
            }
        },
        [items],
    );

    const focusCommandItem = useCallback((index: number) => {
        setTimeout(() => {
            const commandList = commandListRef.current?.querySelector('[data-slot="command-list"]') as HTMLElement;

            if (commandList) {
                const commandItems = commandList.querySelectorAll('[data-slot="command-item"]') as NodeListOf<HTMLElement>;

                if (commandItems.length > 0) {
                    const targetIndex = index < commandItems.length ? index : 0;

                    for (const item of commandItems) {
                        delete item.dataset.highlighted;
                    }

                    const targetItem = commandItems[targetIndex];

                    if (targetItem) {
                        targetItem.setAttribute("tabindex", "0");
                        targetItem.dataset.highlighted = "";
                        targetItem.focus();
                        targetItem.scrollIntoView({ behavior: "smooth", block: "nearest" });
                    }
                }
            }
        }, 0);
    }, []);

    useEffect(() => {
        if (!isOpen || items.length === 0) {
            return undefined;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            const input = document.querySelector(inputSelector) as AnchorInput;
            const { activeElement } = document;
            const isInputFocused = input && (document.activeElement === input || input.contains(document.activeElement as Node));
            const isCommandItemFocused = activeElement?.closest('[data-slot="command-item"]') !== null;
            const isInCommandMenu = commandListRef.current?.contains(activeElement as Node) ?? false;

            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && (isInputFocused || isCommandItemFocused || isInCommandMenu)) {
                event.preventDefault();
                event.stopPropagation();

                const currentIndex = selectedIndexRef.current;
                const newIndex = (currentIndex + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;

                setSelectedIndex(newIndex);
                focusCommandItem(newIndex);
            }

            if (event.key === "Enter" && !event.shiftKey) {
                const commandItem = activeElement?.closest('[data-slot="command-item"]') as HTMLElement;

                if (commandItem) {
                    event.preventDefault();
                    event.stopPropagation();
                    commandItem.click();

                    return;
                }

                if (input && document.activeElement === input && items.length > 0) {
                    event.preventDefault();
                    event.stopPropagation();
                    const currentIndex = selectedIndexRef.current;
                    const selected = items[currentIndex];

                    if (selected && handleSelectVariableRef.current) {
                        handleSelectVariableRef.current(selected.name);
                    }

                    return;
                }
            }

            if (event.key === "Escape" || event.key === "Esc") {
                const isInMenu = commandListRef.current?.contains(document.activeElement as Node) ?? false;

                if (input && (document.activeElement === input || isInMenu)) {
                    event.preventDefault();
                    event.stopPropagation();

                    if (handleEscapeRef.current && restoreFocusRef.current) {
                        handleEscapeRef.current();
                        restoreFocusRef.current();
                    }
                }
            }

            if (event.key === "Tab" && !event.shiftKey && input && document.activeElement === input && items.length > 0) {
                event.preventDefault();
                event.stopPropagation();
                const currentIndex = selectedIndexRef.current;
                const selected = items[currentIndex];

                if (selected && handleSelectVariableRef.current) {
                    handleSelectVariableRef.current(selected.name);
                }
            }
        };

        handleKeyDownRef.current = handleKeyDown;
        globalThis.addEventListener("keydown", handleKeyDown, { capture: true });

        return () => {
            globalThis.removeEventListener("keydown", handleKeyDown, true);
            handleKeyDownRef.current = null;
        };
    }, [isOpen, items, inputSelector, focusCommandItem]);

    return (
        <>
            {children}
            {isOpen && menuPosition && (
                <VariableMenu
                    commandListRef={commandListRef}
                    items={items}
                    onSearchChange={setSearchQuery}
                    onSelect={handleSelectVariable}
                    onValueChange={handleValueChange}
                    position={menuPosition}
                    query={variableMatch?.query ?? ""}
                    searchQuery={searchQuery}
                    selectedValue={selectedValue}
                />
            )}
        </>
    );
};

export default VariableAutocomplete;
