import { describe, expect, it } from "vitest";

import type { BundleReviewEntry } from "./bundle-review";
import { withSelectionSlugs } from "./bundle-review";

const skillEntry = (index: number, baseSlug: string, slug: string): BundleReviewEntry => {
    return {
        key: `skill:${String(index)}`,
        kind: "skill",
        problems: [],
        requires: [],
        skill: { baseSlug, description: "d", disabledTools: [], droppedTools: [], instructions: "i", name: baseSlug, slug, tools: [] },
        title: baseSlug,
        warnings: slug === baseSlug ? [] : [`You already have a skill named "${baseSlug}"; this one will be imported as "${slug}".`],
    };
};

// A file holding foo and foo-2, a recipient who owns foo: with both ticked they become foo-2 and foo-2-2.
const entries = [skillEntry(0, "foo", "foo-2"), skillEntry(1, "foo-2", "foo-2-2")];
const find = (shown: BundleReviewEntry[], key: string): BundleReviewEntry | undefined => shown.find((candidate) => candidate.key === key);

describe("withSelectionSlugs", () => {
    it("shows the slugs of the whole selection as the server previewed them", () => {
        const shown = withSelectionSlugs(entries, new Set(["skill:0", "skill:1"]), ["foo"]);

        expect([find(shown, "skill:0")?.skill?.slug, find(shown, "skill:1")?.skill?.slug]).toStrictEqual(["foo-2", "foo-2-2"]);
    });

    it("gives the second skill the slug the import will pick when the first is unticked", () => {
        const shown = withSelectionSlugs(entries, new Set(["skill:1"]), ["foo"]);

        expect(find(shown, "skill:1")?.skill?.slug).toBe("foo-2");
        expect(find(shown, "skill:1")?.warnings).toStrictEqual([]);
        expect(find(shown, "skill:0")?.skill?.slug).toBe("foo-2");
    });
});
