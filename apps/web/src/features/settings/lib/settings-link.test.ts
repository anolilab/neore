import { describe, expect, it } from "vitest";

import { adminPathFor, settingsLinkSearch, settingsLocation, settingsTabForPath } from "./settings-link";

describe("settingsTabForPath", () => {
    it.each([
        ["/dashboard/settings/app/customization", "app-customization"],
        ["/dashboard/settings/app/keyboard-shortcuts", "app-keyboard"],
        ["/dashboard/settings/app/personalization", "chat-personalization"],
        ["/dashboard/settings/auth/account", "auth-account"],
        ["/dashboard/settings/auth/api-keys", "auth-api-keys"],
        ["/dashboard/settings/auth/members", "auth-members"],
        ["/dashboard/settings/auth/organization", "auth-organization"],
        ["/dashboard/settings/auth/organizations", "auth-organizations"],
        ["/dashboard/settings/auth/security", "auth-security"],
        ["/dashboard/settings/auth/teams", "auth-teams"],
        ["/dashboard/settings/chat/agent", "chat-agent"],
        ["/dashboard/settings/chat/bots", "chat-bots"],
        ["/dashboard/settings/chat/devices", "chat-devices"],
        ["/dashboard/settings/chat/knowledge", "chat-knowledge"],
        ["/dashboard/settings/chat/mcp", "chat-mcp"],
        ["/dashboard/settings/chat/model-filters", "chat-model-filters"],
        ["/dashboard/settings/chat/models", "chat-models"],
        ["/dashboard/settings/chat/triggers", "chat-triggers"],
        ["/dashboard/settings/chat/usage", "chat-usage"],
        ["/dashboard/settings/connectors", "connectors"],
        ["/dashboard/settings/connectors/", "connectors"],
        ["/dashboard/settings/connectors/messenger", "connectors-messenger"],
        ["/dashboard/settings/privacy", "privacy"],
        ["/dashboard/settings/api-keys", "chat-api-keys"],
        ["/dashboard/settings/billing/limits", "auth-billing"],
        ["/dashboard/settings/chat/model", "chat-models"],
        ["/dashboard/settings/compliance/model-filters", "chat-model-filters"],
    ])("maps %s to the %s tab", (path, tab) => {
        expect(settingsTabForPath(path)).toBe(tab);
    });

    it("opens the first tab for the bare settings path and for a settings page that no longer exists", () => {
        expect(settingsTabForPath("/dashboard/settings")).toBe("app-customization");
        expect(settingsTabForPath("/dashboard/settings/chat/constructor")).toBe("app-customization");
    });

    it("leaves the pages that stay pages alone: the OAuth callback and admin", () => {
        expect(settingsTabForPath("/dashboard/settings/connectors/callback")).toBeUndefined();
        expect(settingsTabForPath("/dashboard/settings/admin")).toBeUndefined();
        expect(settingsTabForPath("/dashboard/settings/admin/users")).toBeUndefined();
    });

    it("is not fooled by a path that only starts with the same letters, or by other pages", () => {
        expect(settingsTabForPath("/dashboard/settingsx")).toBeUndefined();
        expect(settingsTabForPath("/dashboard")).toBeUndefined();
        expect(settingsTabForPath("/chat/abc")).toBeUndefined();
    });
});

describe("settingsLinkSearch", () => {
    it("adds the modal's keys and keeps the page's own search", () => {
        expect(settingsLinkSearch("chat-mcp")({ project: "p1" })).toEqual({ project: "p1", settings: true, settingsTab: "chat-mcp" });
    });

    it("drops an anchor an earlier settings link left in the search", () => {
        expect(settingsLinkSearch("chat-mcp")({ settings: true, settingsAnchor: "daily-brief", settingsTab: "auth-account" })).toEqual({
            settings: true,
            settingsTab: "chat-mcp",
        });
    });

    it("carries an anchor only when one is given", () => {
        expect(settingsLinkSearch("auth-account", "daily-brief")({})).toEqual({ settings: true, settingsAnchor: "daily-brief", settingsTab: "auth-account" });
    });
});

describe("settingsLocation", () => {
    it("opens the modal over the chat when there is no page to stay on", () => {
        expect(settingsLocation("connectors")).toEqual({ search: { settings: true, settingsTab: "connectors" }, to: "/chat" });
    });
});

describe("adminPathFor", () => {
    it("sends the old admin settings paths to the admin pages", () => {
        expect(adminPathFor("/dashboard/settings/admin")).toBe("/admin");
        expect(adminPathFor("/dashboard/settings/admin/")).toBe("/admin");
        expect(adminPathFor("/dashboard/settings/admin/users")).toBe("/admin/users");
        expect(adminPathFor("/dashboard/settings/admin/audit-log")).toBe("/admin/audit-log");
    });

    it("leaves every other path alone", () => {
        expect(adminPathFor("/dashboard/settings/administrator")).toBeUndefined();
        expect(adminPathFor("/dashboard/settings/auth/account")).toBeUndefined();
    });
});
