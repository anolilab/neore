import { createHash } from "node:crypto";

import type { MessageDescriptor } from "@lingui/core";
import { setupI18n } from "@lingui/core";
import { describe, expect, it, vi } from "vitest";

import linguiConfig from "../../../../lingui.config";
import type { SettingsKeywordEntry } from "./settings-keywords";
import { SETTINGS_KEYWORDS } from "./settings-keywords";
import type { SettingsTab } from "./settings-navigation";
import { resolveSettingsNavigation, SETTINGS_NAVIGATION } from "./settings-navigation";
import { buildSettingsSearchIndex, normalizeSearchText, searchSettings } from "./settings-search";

// The unit-test transform does not compile Lingui macros, so `msg` is mocked
// with the id Lingui's extractor gives a placeholder-free message (the first
// six base64url characters of its SHA-256), so the real catalogs resolve it.
vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            const message = strings.join("");
            const id = createHash("sha256").update(`${message}\u{1F}`).digest("base64url").slice(0, 6);

            return { id, message };
        },
    };
});

const catalogs = import.meta.glob<{ messages: Record<string, string> }>("../../../locales/*/messages.js", { eager: true });

const SOURCE_LOCALE = "en";

const everyTab = { activeOrganization: true, apiKey: true, organization: true };

/** The navigation and search index as a user of `locale` sees them, every conditional tab listed. */
const searchIn = (locale: string, keywords: Readonly<Record<SettingsTab, ReadonlyArray<SettingsKeywordEntry>>> = SETTINGS_KEYWORDS) => {
    const catalog = catalogs[`../../../locales/${locale}/messages.js`];

    if (!catalog) {
        throw new Error(`No compiled catalog for ${locale}`);
    }

    const i18n = setupI18n({ locale, messages: { [locale]: catalog.messages } });
    const translate = (descriptor: MessageDescriptor) => i18n._(descriptor);
    const navigation = resolveSettingsNavigation(everyTab, translate);
    const index = buildSettingsSearchIndex(navigation, keywords, translate);

    return { index, navigation };
};

const foundTabs = (index: ReturnType<typeof searchIn>["index"], query: string) => searchSettings(index, query).map((group) => group.tab);

describe("settings search", () => {
    describe.each(linguiConfig.locales)("in %s", (locale) => {
        it("finds every tab by its label", () => {
            const { index, navigation } = searchIn(locale);
            const items = navigation.flatMap((group) => group.items);
            const labels = items.map((item) => item.label);

            // A catalog that lacks the labels falls back to English, which would pass this vacuously.
            if (locale !== SOURCE_LOCALE) {
                expect(labels).not.toEqual(searchIn(SOURCE_LOCALE).navigation.flatMap((group) => group.items.map((item) => item.label)));
            }

            for (const item of items) {
                expect(foundTabs(index, item.label), `${locale}: "${item.label}"`).toContain(item.tab);
            }
        });
    });

    it("lists the tabs of the whole navigation", () => {
        const { navigation } = searchIn("en");

        expect(navigation.flatMap((group) => group.items)).toHaveLength(SETTINGS_NAVIGATION.flatMap((group) => group.items).length);
    });

    it("leaves out the tabs whose condition does not hold", () => {
        const navigation = resolveSettingsNavigation(
            { activeOrganization: false, apiKey: false, organization: false },
            (descriptor) => descriptor.message ?? "",
        );
        const tabs = navigation.flatMap((group) => group.items.map((item) => item.tab));

        expect(tabs).not.toContain("auth-api-keys");
        expect(tabs).not.toContain("auth-members");
        expect(tabs).toContain("auth-billing");
    });

    it("ignores case and surrounding space", () => {
        const { index } = searchIn("en");

        expect(foundTabs(index, "  tOoL perMISSIONS ")).toEqual(["chat-tools"]);
    });

    it("ignores accents on either side", () => {
        const { index } = searchIn("en");
        const keywords = {
            ...SETTINGS_KEYWORDS,
            privacy: [{ keywords: [{ id: "Résumé export" }], label: { id: "Daten exportieren" } }],
        };
        const withAccents = searchIn("en", keywords).index;

        expect(foundTabs(withAccents, "resume")).toEqual(["privacy"]);
        expect(foundTabs(withAccents, "RÉSUMÉ")).toEqual(["privacy"]);
        expect(foundTabs(index, "séçürity")).toEqual(["auth-security"]);
    });

    it("keeps the voicing mark of a kana", () => {
        expect(normalizeSearchText("が")).not.toBe(normalizeSearchText("か"));
    });

    it("matches a substring, in navigation order, one group per tab", () => {
        const { index } = searchIn("en");

        expect(foundTabs(index, "api keys")).toEqual(["chat-api-keys", "auth-api-keys"]);
        expect(foundTabs(index, "models")).toEqual(["chat-default-models", "chat-models"]);
    });

    it("finds a tab through the keywords and labels of its settings, under that tab's group", () => {
        const keywords = {
            ...SETTINGS_KEYWORDS,
            "app-keyboard": [{ keywords: [{ id: "hotkey" }], label: { id: "Send message shortcut" }, section: { id: "Chat" } }],
        };
        const { index } = searchIn("en", keywords);
        const [group] = searchSettings(index, "hotkey");

        expect(group?.tab).toBe("app-keyboard");
        expect(group?.entries.map((entry) => entry.label)).toEqual(["Send message shortcut"]);
        expect(foundTabs(index, "send message shortcut")).toEqual(["app-keyboard"]);
    });

    it("finds nothing for an empty or blank query, or one nothing matches", () => {
        const { index } = searchIn("en");

        expect(searchSettings(index, "")).toEqual([]);
        expect(searchSettings(index, " ".repeat(3))).toEqual([]);
        expect(searchSettings(index, "zzzz-no-such-setting")).toEqual([]);
    });
});
