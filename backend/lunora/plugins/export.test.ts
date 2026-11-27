import { describe, expect, it } from "vitest";

import { buildBundleMarkdown, parseBundleMarkdown } from "../skills/bundle-format";
import { withPluginHeader } from "./export";
import { bodyHash } from "./logic";

describe("exporting a plugin", () => {
    it("writes a plugin header whose hash is the body's, so the exported file checks out", async () => {
        const plain = buildBundleMarkdown({ description: "", items: [], name: "Daily brief" });
        const contentHash = await bodyHash(plain);

        const exported = withPluginHeader(plain, { contentHash, slug: "daily-brief", version: "1.0.0" });
        const parsed = parseBundleMarkdown(exported);

        expect(parsed.ok).toBe(true);

        if (parsed.ok) {
            expect(parsed.bundle.plugin).toEqual({ contentHash, slug: "daily-brief", version: "1.0.0" });
        }

        expect(await bodyHash(exported)).toBe(contentHash);
    });

    it("leaves a plain bundle's body alone, so its hash does not depend on the header it was given", async () => {
        const plain = buildBundleMarkdown({ description: "", items: [], name: "Daily brief" });
        const withHeader = withPluginHeader(plain, { contentHash: "0".repeat(64), slug: "daily-brief", version: "1.0.0" });

        expect(await bodyHash(withHeader)).toBe(await bodyHash(plain));
    });
});
