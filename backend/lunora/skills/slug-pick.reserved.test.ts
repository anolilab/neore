import { describe, expect, it } from "vitest";

import { findFreeSlug } from "./slug-pick";

describe(findFreeSlug, () => {
    it.each(["clear", "compact"])("never picks %s, a composer command an imported skill would shadow", (slug) => {
        expect.assertions(1);

        expect(findFreeSlug(slug, new Set())).toBe(`${slug}-2`);
    });
});
