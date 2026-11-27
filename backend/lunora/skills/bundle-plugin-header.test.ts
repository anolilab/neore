import { describe, expect, it } from "vitest";

import { parseBundleMarkdown } from "./bundle-format";

const HASH = "a".repeat(64);

const file = (frontmatter: string[], body = "") => `---\n${frontmatter.join("\n")}\n---\n${body}`;

const v1 = (extra: string[] = []) => file(["bundle: 1", "name: Team", ...extra]);

const v2 = (overrides: Record<string, string> = {}) => {
    const header = { contentHash: HASH, plugin: "daily-brief", pluginVersion: "1.0.0", ...overrides };

    return file(["bundle: 2", "name: Daily brief", ...Object.entries(header).map(([key, value]) => `${key}: ${value}`)]);
};

describe("bundle headers", () => {
    it("parses an ordinary version 1 file as before, with no plugin header", () => {
        const result = parseBundleMarkdown(v1());

        expect(result.ok).toBe(true);

        if (result.ok) {
            expect(result.bundle.plugin).toBeUndefined();
            expect(result.bundle.name).toBe("Team");
        }
    });

    it("reads the plugin header of a version 2 file", () => {
        const result = parseBundleMarkdown(v2());

        expect(result.ok).toBe(true);

        if (result.ok) {
            expect(result.bundle.plugin).toEqual({ contentHash: HASH, slug: "daily-brief", version: "1.0.0" });
        }
    });

    it("refuses a version 2 file with a missing plugin key", () => {
        const result = parseBundleMarkdown(file(["bundle: 2", "name: Daily brief", `contentHash: ${HASH}`, "plugin: daily-brief"]));

        expect(result).toMatchObject({ ok: false });
    });

    it("refuses a plugin header on a version 1 file", () => {
        const result = parseBundleMarkdown(v1([`plugin: daily-brief`, `pluginVersion: 1.0.0`, `contentHash: ${HASH}`]));

        expect(result).toMatchObject({ errors: ["A plugin header needs `bundle: 2`"], ok: false });
    });

    it("refuses a plugin slug, version or hash that is not in the required form", () => {
        expect(parseBundleMarkdown(v2({ plugin: "Daily Brief" }))).toMatchObject({ ok: false });
        expect(parseBundleMarkdown(v2({ pluginVersion: "v1" }))).toMatchObject({ ok: false });
        expect(parseBundleMarkdown(v2({ contentHash: "not-a-hash" }))).toMatchObject({ ok: false });
    });

    it("refuses an unknown version", () => {
        expect(parseBundleMarkdown(file(["bundle: 3", "name: Team"]))).toMatchObject({ ok: false });
    });
});
