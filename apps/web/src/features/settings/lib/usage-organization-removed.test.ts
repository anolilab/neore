/**
 * The totals of projects an organization no longer has add up across the pages of its members, and name no project.
 */
import { describe, expect, it } from "vitest";

import type { OrganizationUsagePage } from "./usage-organization";
import { sumOrganizationUsage } from "./usage-organization";

describe("sumOrganizationUsage: the removed projects", () => {
    it("adds the removed totals of every page, and leaves them out when no page has any", async () => {
        const pages: OrganizationUsagePage[] = [
            { nextCursor: "a", projects: [], removed: { costMicrodollars: 100, replies: 1, tokens: 10 }, truncated: false },
            { projects: [], removed: { costMicrodollars: 50, replies: 2, tokens: 5 }, truncated: false },
        ];
        const queue = [...pages];
        const summed = await sumOrganizationUsage(async () => queue.shift() as OrganizationUsagePage);

        expect(summed.removed).toEqual({ costMicrodollars: 150, replies: 3, tokens: 15 });

        const empty: OrganizationUsagePage = { projects: [], truncated: false };
        const none = await sumOrganizationUsage(async () => empty);

        expect(none).not.toHaveProperty("removed");
    });
});
