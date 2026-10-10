import { describe, expect, it, vi } from "vitest";

import { breadcrumbLabel, DASHBOARD_PAGE_NAMES, settingsPageName } from "./dashboard-page-names";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { id: strings.join("") };
        },
    };
});

/** Stands in for `i18n._`: marks what went through translation. */
const translate = (descriptor: { id?: string }) => `«${descriptor.id ?? ""}»`;

describe(breadcrumbLabel, () => {
    it("names a known segment with the same descriptor the nav uses", () => {
        expect(breadcrumbLabel("model-filters", translate)).toBe(translate(DASHBOARD_PAGE_NAMES.modelRestrictions));
        expect(breadcrumbLabel("dashboard", translate)).toBe(translate(DASHBOARD_PAGE_NAMES.home));
        expect(breadcrumbLabel("privacy", translate)).toBe("«Privacy & Data»");
    });

    it("keeps a dynamic id as it is", () => {
        expect(breadcrumbLabel("k57f2x9", translate)).toBe("k57f2x9");
    });

    it("does not read inherited keys as page names", () => {
        expect(breadcrumbLabel("constructor", translate)).toBe("constructor");
        expect(breadcrumbLabel("toString", translate)).toBe("toString");
    });
});

describe(settingsPageName, () => {
    it("names a settings page by its last segment, as the breadcrumb does", () => {
        expect(settingsPageName("/dashboard/settings/app/customization")).toBe(DASHBOARD_PAGE_NAMES.customization);
        expect(settingsPageName("/dashboard/settings/chat/model-filters")).toBe(DASHBOARD_PAGE_NAMES.modelRestrictions);
        expect(settingsPageName("/dashboard/settings/privacy")).toBe(DASHBOARD_PAGE_NAMES.privacyAndData);
        expect(settingsPageName("/dashboard/settings/connectors/")).toBe(DASHBOARD_PAGE_NAMES.connectors);
    });

    it("names nothing off the settings tree", () => {
        expect(settingsPageName("/dashboard")).toBeUndefined();
        expect(settingsPageName("/chat/settings/account")).toBeUndefined();
    });

    it("names nothing for a page without a name of its own", () => {
        expect(settingsPageName("/dashboard/settings/connectors/callback")).toBeUndefined();
        expect(settingsPageName("/dashboard/settings/chat/constructor")).toBeUndefined();
    });
});
