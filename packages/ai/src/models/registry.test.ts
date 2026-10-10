import { describe, expect, it } from "vitest";

import { ALL_CATALOG, buildAgents, IMAGE_CATALOG, MODEL_REGISTRY, MUSIC_CATALOG, TEXT_CATALOG, VIDEO_CATALOG } from "./registry";

// ── Catalog derivation ────────────────────────────────────────────────────────

describe("deriveCatalog", () => {
    it("TEXT_CATALOG should contain entries", () => {
        expect(TEXT_CATALOG.length).toBeGreaterThan(0);
    });

    it("IMAGE_CATALOG should contain entries", () => {
        expect(IMAGE_CATALOG.length).toBeGreaterThan(0);
    });

    it("VIDEO_CATALOG should contain entries", () => {
        expect(VIDEO_CATALOG.length).toBeGreaterThan(0);
    });

    it("ALL_CATALOG should equal sum of text, image, video, and music catalogs", () => {
        expect(ALL_CATALOG).toHaveLength(TEXT_CATALOG.length + IMAGE_CATALOG.length + VIDEO_CATALOG.length + MUSIC_CATALOG.length);
    });

    it("every catalog entry should have required fields", () => {
        for (const entry of ALL_CATALOG) {
            expect(entry.slug).toBeTruthy();
            expect(entry.name).toBeTruthy();
            expect(entry.provider).toBeTruthy();
            expect(["budget", "fast", "frontier", "high-quality", "medium"]).toContain(entry.tier);
            expect(["text", "image", "video", "music"]).toContain(entry.mode);
        }
    });

    it("TEXT_CATALOG entries should all have mode 'text'", () => {
        for (const entry of TEXT_CATALOG) {
            expect(entry.mode).toBe("text");
        }
    });

    it("IMAGE_CATALOG entries should all have mode 'image'", () => {
        for (const entry of IMAGE_CATALOG) {
            expect(entry.mode).toBe("image");
        }
    });

    it("VIDEO_CATALOG entries should all have mode 'video'", () => {
        for (const entry of VIDEO_CATALOG) {
            expect(entry.mode).toBe("video");
        }
    });

    it("MUSIC_CATALOG entries should all have mode 'music'", () => {
        for (const entry of MUSIC_CATALOG) {
            expect(entry.mode).toBe("music");
        }
    });

    it("catalog slugs should be unique", () => {
        const slugs = ALL_CATALOG.map((entry) => entry.slug);
        const uniqueSlugs = new Set(slugs);

        expect(uniqueSlugs.size).toBe(slugs.length);
    });
});

// ── MODEL_REGISTRY integrity ──────────────────────────────────────────────────

describe("MODEL_REGISTRY", () => {
    it("should contain models", () => {
        expect(MODEL_REGISTRY.length).toBeGreaterThan(0);
    });

    it("every model should have an id and provider", () => {
        for (const model of MODEL_REGISTRY) {
            expect(model.id).toBeTruthy();
            expect(model.provider).toBeTruthy();
        }
    });

    it("listed models should have slug, name, desc, and displayProvider", () => {
        const listed = MODEL_REGISTRY.filter((m) => m.listed);

        expect(listed.length).toBeGreaterThan(0);

        for (const model of listed) {
            expect(model.slug).toBeTruthy();
            expect(model.name).toBeTruthy();
            expect(model.desc).toBeTruthy();
            expect(model.displayProvider).toBeTruthy();
        }
    });

    it("model ids should be unique", () => {
        const ids = MODEL_REGISTRY.map((m) => m.id);
        const uniqueIds = new Set(ids);

        expect(uniqueIds.size).toBe(ids.length);
    });

    it("text models without explicit mode should appear in TEXT_CATALOG when listed", () => {
        const listedTextModels = MODEL_REGISTRY.filter((m) => m.listed && m.enabled !== false && !m.mode && m.slug);

        // All listed text models (no explicit mode) should appear in TEXT_CATALOG
        for (const model of listedTextModels) {
            const found = TEXT_CATALOG.find((entry) => entry.slug === model.slug);

            expect(found, `Expected ${model.slug} to be in TEXT_CATALOG`).toBeDefined();
        }
    });
});

describe("buildAgents without a Replicate token", () => {
    it("builds the rest instead of throwing (the Replicate SDK reads its token at model creation)", async () => {
        const saved = process.env.REPLICATE_API_TOKEN;

        delete process.env.REPLICATE_API_TOKEN;

        try {
            const agents = await buildAgents();

            expect(Object.keys(agents).some((id) => id.startsWith("replicate/"))).toBe(false);
            expect(Object.keys(agents).length).toBeGreaterThan(0);
        } finally {
            if (saved !== undefined) {
                process.env.REPLICATE_API_TOKEN = saved;
            }
        }
    });
});
