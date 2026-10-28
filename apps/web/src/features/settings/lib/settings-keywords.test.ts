import { describe, expect, it, vi } from "vitest";

import { SETTINGS_KEYWORDS } from "./settings-keywords";
import type { SettingsTab } from "./settings-navigation";
import { SETTINGS_NAVIGATION, SETTINGS_TABS } from "./settings-navigation";

// The unit-test transform does not compile Lingui macros.
vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { id: strings.join("") };
        },
    };
});

/** The tabs without a keyword list (an empty list counts; a missing one does not). */
const tabsWithoutKeywordList = (tabs: ReadonlyArray<SettingsTab>, keywords: Partial<Record<SettingsTab, unknown>>) =>
    tabs.filter((tab) => !Array.isArray(keywords[tab]));

describe("settings keyword lists", () => {
    it("has a list for every tab in the navigation", () => {
        const navigationTabs = SETTINGS_NAVIGATION.flatMap((group) => group.items.map((item) => item.tab));

        expect(tabsWithoutKeywordList(navigationTabs, SETTINGS_KEYWORDS)).toEqual([]);
    });

    it("has a list for every settings tab", () => {
        expect(tabsWithoutKeywordList(SETTINGS_TABS, SETTINGS_KEYWORDS)).toEqual([]);
    });

    it("names the tab that has none", () => {
        const withoutPrivacy: Partial<Record<SettingsTab, unknown>> = { ...SETTINGS_KEYWORDS };

        delete withoutPrivacy.privacy;

        expect(tabsWithoutKeywordList(SETTINGS_TABS, withoutPrivacy)).toEqual(["privacy"]);
    });

    it("lists a tab's settings under labels of their own, each once", () => {
        const items = SETTINGS_NAVIGATION.flatMap((group) => group.items);

        for (const item of items) {
            const labels = SETTINGS_KEYWORDS[item.tab].map((entry) => entry.label.id);

            expect(labels, `${item.tab} repeats its own label`).not.toContain(item.label.id);
            expect(new Set(labels).size, `${item.tab} repeats a setting`).toBe(labels.length);
        }
    });
});
