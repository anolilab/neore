import { describe, expect, it } from "vitest";

import { buildPageManifest, pageManifestHref } from "./page-manifest";

const FIRST = "1d0e2944-748e-4cd8-b8f4-7cd88273786a";
const SECOND = "9b2f6c1e-0a3d-4e7b-8c5a-2f1d9e8b7a60";

describe("buildPageManifest", () => {
    it("gives each page its own id, start URL and scope", () => {
        const first = buildPageManifest(FIRST);
        const second = buildPageManifest(SECOND);

        expect(first).toMatchObject({ id: `/pages/${FIRST}`, scope: `/pages/${FIRST}`, start_url: `/pages/${FIRST}` });
        expect(second).toMatchObject({ id: `/pages/${SECOND}`, scope: `/pages/${SECOND}`, start_url: `/pages/${SECOND}` });
    });

    it("uses the same generic name and the Neore icons for every page, so no title is exposed", () => {
        const manifest = buildPageManifest(FIRST);

        expect(manifest).toMatchObject({ name: "Neore page", short_name: "Neore page", display: "standalone" });
        expect(manifest?.icons).toEqual([
            { sizes: "192x192", src: "/pwa-icon-192x192.png", type: "image/png" },
            { sizes: "512x512", src: "/pwa-icon-512x512.png", type: "image/png" },
        ]);
    });

    it("refuses anything that is not a Lunora row id, and never echoes it", () => {
        expect(buildPageManifest("")).toBeUndefined();
        expect(buildPageManifest("../settings")).toBeUndefined();
        expect(buildPageManifest("page one")).toBeUndefined();
        expect(buildPageManifest("page_1")).toBeUndefined();
        expect(buildPageManifest(FIRST.toUpperCase())).toBeUndefined();
    });
});

describe("pageManifestHref", () => {
    it("points at the page's manifest route", () => {
        expect(pageManifestHref(FIRST)).toBe(`/page-manifest/${FIRST}`);
    });
});
