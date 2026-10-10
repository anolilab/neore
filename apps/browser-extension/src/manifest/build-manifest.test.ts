import { describe, expect, it } from "vitest";

import type { ManifestInput } from "./build-manifest";
import { BACKGROUND_PATH, buildManifest, FIREFOX_MIN_VERSION, GECKO_ID, SIDEBAR_PATH } from "./build-manifest";

const input = (overrides: Partial<ManifestInput> = {}): ManifestInput => {
    return {
        appUrl: "https://app.example.test",
        browser: "chrome",
        command: "build",
        description: "Test",
        gatewayUrl: "https://gateway.example.test",
        lunoraUrl: "https://api.example.test:8443",
        name: "Anole Chat",
        version: "1.2.3",
        ...overrides,
    };
};

describe("buildManifest — chrome", () => {
    const manifest = buildManifest(input());

    it("uses a service worker and the side panel", () => {
        expect(manifest.background).toEqual({ service_worker: BACKGROUND_PATH, type: "module" });
        expect(manifest.side_panel).toEqual({ default_path: SIDEBAR_PATH });
        expect(manifest.permissions).toContain("sidePanel");
        expect(manifest.sidebar_action).toBeUndefined();
        expect(manifest.browser_specific_settings).toBeUndefined();
    });

    it("grants host access to the app (cookie session), backend and gateway only", () => {
        expect(manifest.host_permissions).toEqual(["https://app.example.test/*", "https://api.example.test:8443/*", "https://gateway.example.test/*"]);
        expect(manifest.permissions).not.toContain("identity");
    });

    it("lists permissions sorted, and lets connect-src reach the same origins over WebSocket", () => {
        expect(manifest.permissions).toEqual(["activeTab", "contextMenus", "scripting", "sidePanel", "storage"]);
        expect(manifest.content_security_policy?.extension_pages).toContain(
            "connect-src 'self' https://app.example.test https://api.example.test:8443 https://gateway.example.test wss://app.example.test wss://api.example.test:8443 wss://gateway.example.test",
        );
    });
});

describe("buildManifest — firefox", () => {
    const manifest = buildManifest(input({ browser: "firefox" }));

    it("uses background scripts, not a service worker", () => {
        expect(manifest.background).toEqual({ scripts: [BACKGROUND_PATH] });
    });

    it("declares a sidebar instead of a side panel", () => {
        expect(manifest.side_panel).toBeUndefined();
        expect(manifest.minimum_chrome_version).toBeUndefined();
        expect(manifest.permissions).not.toContain("sidePanel");
        expect(manifest.sidebar_action).toMatchObject({ default_panel: SIDEBAR_PATH, open_at_install: false });
    });

    it("pins the add-on id, minimum version and data-collection declaration AMO requires", () => {
        expect(manifest.browser_specific_settings?.gecko).toEqual({
            data_collection_permissions: { required: ["authenticationInfo", "personalCommunications", "websiteContent"] },
            id: GECKO_ID,
            strict_min_version: FIREFOX_MIN_VERSION,
        });
    });

    it("signs in through identity and needs no host access to the app origin", () => {
        expect(manifest.permissions).toEqual(["activeTab", "contextMenus", "identity", "scripting", "storage"]);
        expect(manifest.host_permissions).toEqual(["https://api.example.test:8443/*", "https://gateway.example.test/*"]);
        expect(manifest.content_security_policy?.extension_pages).not.toContain("app.example.test");
        expect(manifest.content_security_policy?.extension_pages).toContain("wss://api.example.test:8443");
    });

    it("keeps feature parity: the same commands and action", () => {
        const chrome = buildManifest(input());

        expect(manifest.commands).toEqual(chrome.commands);
        expect(manifest.action).toEqual(chrome.action);
    });
});

describe("buildManifest — dev server", () => {
    it("omits the CSP so HMR can connect", () => {
        expect(buildManifest(input({ command: "serve" })).content_security_policy).toBeUndefined();
    });

    it("drops unset and unparsable origins", () => {
        expect(buildManifest(input({ gatewayUrl: "not a url", lunoraUrl: undefined })).host_permissions).toEqual(["https://app.example.test/*"]);
    });
});
