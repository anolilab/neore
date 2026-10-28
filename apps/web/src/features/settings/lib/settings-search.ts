import type { MessageDescriptor } from "@lingui/core";

import type { SettingsKeywordEntry } from "./settings-keywords";
import type { SettingsNavGroup, SettingsTab } from "./settings-navigation";

export interface SettingsSearchEntry {
    /** The navigation group the tab sits in. */
    group: string;
    /** A tab of the navigation, or one setting its keyword list declares. */
    kind: "setting" | "tab";
    /** What the user sees for this result. */
    label: string;
    section?: string;
    tab: SettingsTab;
    /** The tab's own label; the tab-level entry shares it with `label`. */
    tabLabel: string;
    /** Normalized label and keywords; a query matches when it is a substring of any of them. */
    terms: string[];
}

export interface SettingsSearchGroup {
    entries: SettingsSearchEntry[];
    tab: SettingsTab;
}

/** What tells one result from another across queries; unlike its position, it survives the list changing. */
export const settingsEntryKey = (entry: SettingsSearchEntry): string => `${entry.kind}-${entry.tab}-${entry.section ?? ""}-${entry.label}`;

/** Lower-cased with Latin accents removed. Only combining marks U+0300–U+036F go: a wider class would also drop kana voicing marks. */
export const normalizeSearchText = (text: string): string =>
    text
        .normalize("NFD")
        .replaceAll(/[\u{0300}-\u{036F}]/gu, "")
        .toLowerCase();

/** One entry per tab in the navigation, then one per setting the tab's keyword list declares, in navigation order. */
export const buildSettingsSearchIndex = (
    navigation: ReadonlyArray<SettingsNavGroup>,
    keywords: Readonly<Record<SettingsTab, ReadonlyArray<SettingsKeywordEntry>>>,
    translate: (descriptor: MessageDescriptor) => string,
): SettingsSearchEntry[] =>
    navigation.flatMap((group) =>
        group.items.flatMap((item) => {
            const tabEntry: SettingsSearchEntry = {
                group: group.label,
                kind: "tab",
                label: item.label,
                tab: item.tab,
                tabLabel: item.label,
                terms: [normalizeSearchText(item.label)],
            };
            const settingEntries = keywords[item.tab].map((setting): SettingsSearchEntry => {
                const label = translate(setting.label);

                return {
                    group: group.label,
                    kind: "setting",
                    label,
                    section: setting.section && translate(setting.section),
                    tab: item.tab,
                    tabLabel: item.label,
                    terms: [label, ...setting.keywords.map((keyword) => translate(keyword))].map((term) => normalizeSearchText(term)),
                };
            });

            return [tabEntry, ...settingEntries];
        }),
    );

/** The entries a query matches, grouped by tab. The index is already in navigation order, so the groups are too. */
export const searchSettings = (index: ReadonlyArray<SettingsSearchEntry>, query: string): SettingsSearchGroup[] => {
    const needle = normalizeSearchText(query.trim());

    if (!needle) {
        return [];
    }

    const groups: SettingsSearchGroup[] = [];

    for (const entry of index) {
        if (entry.terms.every((term) => !term.includes(needle))) {
            continue;
        }

        const last = groups.at(-1);

        if (last?.tab === entry.tab) {
            last.entries.push(entry);
        } else {
            groups.push({ entries: [entry], tab: entry.tab });
        }
    }

    return groups;
};
