import { describe, expect, it } from "vitest";

import { buildPageManifest, isPageId } from "./page-manifest";

const FIRST = "1d0e2944-748e-4cd8-b8f4-7cd88273786a";
const SECOND = "9b2f6c1e-0a3d-4e7b-8c5a-2f1d9e8b7a60";

describe("buildPageManifest", () => {
    it("gives each page its own id, start URL and scope", () => {
        const first = buildPageManifest(FIRST);
        const second = buildPageManifest(SECOND);

        expect(first).toMatchObject({ id: `/pages/${FIRST}`, scope: `/pages/${FIRST}`, start_url: `/pages/${FIRST}` });
        expect(second).toMatchObject({ id: `/pages/${SECOND}`, scope: `/pages/${SECOND}`, start_url: `/pages/${SECOND}` });
    });

    it("refuses an id that is not a plain URL segment, and never echoes it", () => {
        expect(buildPageManifest("")).toBeUndefined();
        expect(buildPageManifest("../settings")).toBeUndefined();
        expect(buildPageManifest("a#b")).toBeUndefined();
        expect(buildPageManifest("page one")).toBeUndefined();
    });
});

describe("isPageId", () => {
    it("accepts a Lunora row id and an imported page's source id", () => {
        expect(isPageId(FIRST)).toBe(true);
        expect(isPageId("legacy-page-1")).toBe(true);
    });

    it("refuses ids that would change the URL's shape, and ids over 128 characters", () => {
        expect(isPageId("a?b")).toBe(false);
        expect(isPageId("a#b")).toBe(false);
        expect(isPageId("..")).toBe(false);
        expect(isPageId("a".repeat(129))).toBe(false);
    });
});
