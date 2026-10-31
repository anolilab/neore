import { describe, expect, it } from "vitest";

import { pickFreeSlug } from "./slug";

describe("pickFreeSlug", () => {
    it("never ends a suffixed slug in a doubled hyphen when the cut falls on a hyphen", () => {
        const slug = `${"a".repeat(59)}-bcd`;
        const picked = pickFreeSlug(slug, new Set([slug]));

        expect(picked).toBe(`${"a".repeat(59)}-2`);
        expect(picked).not.toContain("--");
    });
});
