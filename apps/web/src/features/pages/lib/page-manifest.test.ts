import { describe, expect, it } from "vitest";

import { buildPageManifest, isPageId, pageManifestHref } from "./page-manifest";

describe("buildPageManifest", () => {
    it("gives each page its own id, start URL and scope", () => {
        const first = buildPageManifest("page_one");
        const second = buildPageManifest("page_two");

        expect(first).toMatchObject({ id: "/pages/page_one", scope: "/pages/page_one", start_url: "/pages/page_one" });
        expect(second).toMatchObject({ id: "/pages/page_two", scope: "/pages/page_two", start_url: "/pages/page_two" });
    });

    it("uses the same generic name and the Neore icons for every page, so no title is exposed", () => {
        const manifest = buildPageManifest("page_one");

        expect(manifest).toMatchObject({ name: "Neore page", short_name: "Neore page", display: "standalone" });
        expect(manifest?.icons).toEqual([
            { sizes: "192x192", src: "/pwa-icon-192x192.png", type: "image/png" },
            { sizes: "512x512", src: "/pwa-icon-512x512.png", type: "image/png" },
        ]);
    });

    it("refuses an id that is not a plain URL segment", () => {
        expect(buildPageManifest("")).toBeUndefined();
        expect(buildPageManifest("../settings")).toBeUndefined();
        expect(buildPageManifest("page one")).toBeUndefined();
        expect(buildPageManifest("a".repeat(129))).toBeUndefined();
    });
});

describe("isPageId", () => {
    it("accepts letters, digits, underscores and dashes up to 128 characters", () => {
        expect(isPageId("page_1-abc")).toBe(true);
        expect(isPageId("a".repeat(128))).toBe(true);
    });
});

describe("pageManifestHref", () => {
    it("points at the page's manifest route", () => {
        expect(pageManifestHref("page_1")).toBe("/page-manifest/page_1");
    });
});
