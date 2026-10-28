"use client";

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Input } from "@neore/ui/components/input";
import cn from "@neore/ui/utils/cn";
import { Lock, Search } from "lucide-react";
import type { FC, KeyboardEvent, Ref } from "react";
import { useId, useMemo, useState } from "react";

import { SETTINGS_KEYWORDS } from "@/features/settings/lib/settings-keywords";
import type { SettingsNavGroup, SettingsTab } from "@/features/settings/lib/settings-navigation";
import type { SettingsSearchEntry } from "@/features/settings/lib/settings-search";
import { buildSettingsSearchIndex, searchSettings, settingsEntryKey } from "@/features/settings/lib/settings-search";

/** Anything an element id should not carry: ids named by `aria-activedescendant` stay one token. */
const NON_ID_CHARACTERS = /[^\p{L}\p{N}]+/gu;

/** The query, what it finds in the navigation the user can see, and which result is selected. */
export const useSettingsSearch = (navigation: ReadonlyArray<SettingsNavGroup>) => {
    const { t } = useLingui();
    const baseId = useId();
    const [query, setQueryState] = useState("");
    const [selected, setSelected] = useState(0);
    const index = useMemo(() => buildSettingsSearchIndex(navigation, SETTINGS_KEYWORDS, t), [navigation, t]);
    const groups = useMemo(() => searchSettings(index, query), [index, query]);
    const entries = useMemo(() => groups.flatMap((group) => group.entries), [groups]);
    // The navigation can change under an open query, so the stored position is clamped rather than trusted.
    const activeIndex = Math.min(selected, entries.length - 1);

    // A new query is a new list: selection starts on its first result.
    const setQuery = (value: string) => {
        setQueryState(value);
        setSelected(0);
    };

    // Built from the entry, not its position: the id `aria-activedescendant` names changes when a different result is on top.
    const optionId = (entry: SettingsSearchEntry): string => `${baseId}-option-${settingsEntryKey(entry).replaceAll(NON_ID_CHARACTERS, "-")}`;
    const activeEntry = entries[activeIndex];

    /** Moves the selection one result, wrapping at the ends, and brings it into view in the list. */
    const moveActive = (step: 1 | -1): void => {
        if (entries.length === 0) {
            return;
        }

        const next = (activeIndex + step + entries.length) % entries.length;
        const entry = entries[next];

        setSelected(next);

        if (entry) {
            // The options are all in the DOM already; only which one is selected changes. Hovering moves the selection too and must not scroll.
            document.querySelector(`#${CSS.escape(optionId(entry))}`)?.scrollIntoView({ block: "nearest" });
        }
    };

    return {
        activeEntry,
        activeIndex,
        activeOptionId: activeEntry && optionId(activeEntry),
        groups,
        isSearching: query.trim() !== "",
        listboxId: `${baseId}-results`,
        moveActive,
        optionId,
        query,
        resultCount: entries.length,
        setActive: setSelected,
        setQuery,
    };
};

type SettingsSearchState = ReturnType<typeof useSettingsSearch>;

/**
 * A combobox over the results: focus stays in the field, the selected result is announced through
 * `aria-activedescendant`, and the result count through a live region. Escape clears the query first and only
 * reaches the dialog once the field is empty.
 */
export const SettingsSearchField: FC<
    Pick<SettingsSearchState, "activeOptionId" | "isSearching" | "listboxId" | "query" | "resultCount" | "setQuery"> & {
        /** Shown in the live region while there is no query, e.g. where the last result led. */
        announcement?: string;
        inputRef?: Ref<HTMLInputElement>;
        onActivate: () => void;
        onMove: (step: 1 | -1) => void;
    }
> = ({ activeOptionId, announcement = "", inputRef, isSearching, listboxId, onActivate, onMove, query, resultCount, setQuery }) => {
    const { t } = useLingui();
    // Inside `t`: a bare `plural()` compiles to the global i18n, which this app never activates.
    // eslint-disable-next-line no-restricted-syntax -- the macro compiles this to a message, not a string conversion
    const resultSummary = t`${plural(resultCount, { one: "# result", other: "# results" })}`;
    const status = isSearching ? resultSummary : announcement;
    const isExpanded = isSearching && resultCount > 0;

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        // While an input method is composing, the arrow keys pick its candidates, not a result.
        if (event.nativeEvent.isComposing && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            return;
        }

        switch (event.key) {
            case "ArrowDown": {
                event.preventDefault();
                onMove(1);
                break;
            }
            case "ArrowUp": {
                event.preventDefault();
                onMove(-1);
                break;
            }
            case "Enter": {
                // Enter confirms an IME composition before it means "open".
                if (isExpanded && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    onActivate();
                }

                break;
            }
            case "Escape": {
                if (query !== "") {
                    event.preventDefault();
                    event.stopPropagation();
                    setQuery("");
                }

                break;
            }
            default: {
                break;
            }
        }
    };

    return (
        <div className="px-2 pb-2">
            <div className="relative">
                <Search aria-hidden className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                <Input
                    aria-activedescendant={isExpanded ? activeOptionId : undefined}
                    aria-autocomplete="list"
                    aria-controls={isExpanded ? listboxId : undefined}
                    aria-expanded={isExpanded}
                    aria-label={t`Search settings`}
                    className="pl-9"
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={t`Search settings...`}
                    ref={inputRef}
                    role="combobox"
                    type="search"
                    value={query}
                />
            </div>
            <span aria-live="polite" className="sr-only" role="status">
                {status}
            </span>
        </div>
    );
};

/** The results as the listbox the field controls, grouped by tab. Options are not in the tab order: the field drives them. */
export const SettingsSearchResults: FC<
    Pick<SettingsSearchState, "activeIndex" | "groups" | "isSearching" | "listboxId" | "optionId" | "setActive"> & {
        /** Tabs a guest cannot open; their results carry the lock the navigation shows. */
        lockedTabs: ReadonlySet<SettingsTab>;
        onSelect: (entry: SettingsSearchEntry) => void;
    }
> = ({ activeIndex, groups, isSearching, listboxId, lockedTabs, onSelect, optionId, setActive }) => {
    const { t } = useLingui();

    if (!isSearching) {
        return null;
    }

    if (groups.length === 0) {
        return <p className="text-muted-foreground px-3 py-2 text-sm">{t`No results`}</p>;
    }

    const entries = groups.flatMap((group) => group.entries);

    return (
        <div aria-label={t`Settings search results`} className="flex flex-col gap-1 p-2" id={listboxId} role="listbox">
            {groups.map((group) => (
                <div aria-label={group.entries[0]?.tabLabel} key={group.tab} role="group">
                    {group.entries.map((entry) => {
                        const entryPosition = entries.indexOf(entry);
                        const isActive = entryPosition === activeIndex;
                        const isLocked = lockedTabs.has(entry.tab);

                        return (
                            <button
                                aria-selected={isActive}
                                className={cn(
                                    "text-muted-foreground flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
                                    isActive ? "bg-muted text-foreground" : "hover:bg-muted hover:text-foreground",
                                )}
                                id={optionId(entry)}
                                key={settingsEntryKey(entry)}
                                onClick={() => onSelect(entry)}
                                onMouseEnter={() => setActive(entryPosition)}
                                role="option"
                                tabIndex={-1}
                                type="button"
                            >
                                <span className="flex min-w-0 flex-1 flex-col">
                                    <span className="text-foreground">{entry.label}</span>
                                    <span className="text-xs">{entry.section ? `${entry.tabLabel} · ${entry.section}` : entry.group}</span>
                                </span>
                                {isLocked && (
                                    <>
                                        <Lock aria-hidden className="size-3 shrink-0 opacity-50" />
                                        <span className="sr-only">{t`Requires an account`}</span>
                                    </>
                                )}
                            </button>
                        );
                    })}
                </div>
            ))}
        </div>
    );
};
