"use client";

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Input } from "@neore/ui/components/input";
import { Search } from "lucide-react";
import type { FC, Ref } from "react";
import { useMemo, useState } from "react";

import { SETTINGS_KEYWORDS } from "@/features/settings/lib/settings-keywords";
import type { SettingsNavGroup, SettingsTab } from "@/features/settings/lib/settings-navigation";
import { buildSettingsSearchIndex, searchSettings } from "@/features/settings/lib/settings-search";

/** The query, and what it finds in the navigation the user can see. */
export const useSettingsSearch = (navigation: ReadonlyArray<SettingsNavGroup>) => {
    const { t } = useLingui();
    const [query, setQuery] = useState("");
    const index = useMemo(() => buildSettingsSearchIndex(navigation, SETTINGS_KEYWORDS, t), [navigation, t]);
    const groups = useMemo(() => searchSettings(index, query), [index, query]);
    const resultCount = groups.reduce((count, group) => count + group.entries.length, 0);

    return { groups, isSearching: query.trim() !== "", query, resultCount, setQuery };
};

type SettingsSearchState = ReturnType<typeof useSettingsSearch>;

/** The field is a combobox over the results list; it also owns the live region that announces how many there are. */
export const SettingsSearchField: FC<
    Pick<SettingsSearchState, "isSearching" | "query" | "resultCount" | "setQuery"> & { inputRef?: Ref<HTMLInputElement>; resultsId: string }
> = ({ inputRef, isSearching, query, resultCount, resultsId, setQuery }) => {
    const { t } = useLingui();
    const isExpanded = isSearching && resultCount > 0;
    // Inside `t`: a bare `plural()` compiles to the global i18n, which this app never activates.
    // eslint-disable-next-line no-restricted-syntax -- the macro compiles this to a message, not a string conversion
    const resultSummary = t`${plural(resultCount, { one: "# result", other: "# results" })}`;
    const status = isSearching ? resultSummary : "";

    return (
        <div className="px-2 pb-2">
            <div className="relative">
                <Search aria-hidden className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                <Input
                    aria-autocomplete="list"
                    aria-controls={isExpanded ? resultsId : undefined}
                    aria-expanded={isExpanded}
                    aria-label={t`Search settings`}
                    className="pl-9"
                    onChange={(event) => setQuery(event.target.value)}
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

export const SettingsSearchResults: FC<Pick<SettingsSearchState, "groups" | "isSearching"> & { id: string; onSelect: (tab: SettingsTab) => void }> = ({
    groups,
    id,
    isSearching,
    onSelect,
}) => {
    const { t } = useLingui();

    if (!isSearching) {
        return null;
    }

    if (groups.length === 0) {
        return <p className="text-muted-foreground px-3 py-2 text-sm">{t`No results`}</p>;
    }

    return (
        <div aria-label={t`Settings search results`} className="flex flex-col gap-1 p-2" id={id} role="listbox">
            {groups.map((group) => (
                <div aria-label={group.entries[0]?.tabLabel} key={group.tab} role="group">
                    {group.entries.map((entry) => (
                        <button
                            aria-selected={false}
                            className="text-muted-foreground hover:bg-muted hover:text-foreground flex w-full flex-col rounded-md px-3 py-2 text-left text-sm transition-colors"
                            key={`${entry.tab}-${entry.section ?? ""}-${entry.label}`}
                            onClick={() => onSelect(entry.tab)}
                            role="option"
                            type="button"
                        >
                            <span className="text-foreground">{entry.label}</span>
                            <span className="text-xs">{entry.section ? `${entry.tabLabel} · ${entry.section}` : entry.group}</span>
                        </button>
                    ))}
                </div>
            ))}
        </div>
    );
};
