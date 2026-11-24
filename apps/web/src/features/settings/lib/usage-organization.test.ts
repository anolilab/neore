import { describe, expect, it, vi } from "vitest";

import type { OrganizationUsagePage } from "./usage-organization";
import { MAX_ORGANIZATION_PAGES, organizationSinceOf, sumOrganizationUsage } from "./usage-organization";

const project = (projectKey: string, costMicrodollars: number) => {
    return { costMicrodollars, projectKey, replies: 1, title: projectKey, tokens: 10 };
};

describe("sumOrganizationUsage", () => {
    it("adds every page of members up per project, following the cursor", async () => {
        const fetchPage = vi.fn(async (after: string | undefined) =>
            after === undefined
                ? { nextCursor: "u25", projects: [project("alpha", 100), project("beta", 10)], truncated: false }
                : { projects: [project("alpha", 50), project("beta", 200)], truncated: false },
        );

        const result = await sumOrganizationUsage(fetchPage);

        expect(fetchPage.mock.calls.map(([after]) => after)).toStrictEqual([undefined, "u25"]);
        expect(result).toStrictEqual({
            projects: [
                { costMicrodollars: 210, projectKey: "beta", replies: 2, title: "beta", tokens: 20 },
                { costMicrodollars: 150, projectKey: "alpha", replies: 2, title: "alpha", tokens: 20 },
            ],
            truncated: false,
        });
    });

    it("stops at the page cap and says the result is partial", async () => {
        const fetchPage = vi.fn(async () => {
            return { nextCursor: "more", projects: [], truncated: false };
        });

        const result = await sumOrganizationUsage(fetchPage);

        expect(fetchPage).toHaveBeenCalledTimes(MAX_ORGANIZATION_PAGES);
        expect(result.truncated).toBe(true);
    });
});

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

describe("the instant an organization period starts at", () => {
    it("is the chosen date's UTC midnight, the same for viewers in every zone", () => {
        expect(organizationSinceOf("2026-03-10")).toBe(Date.UTC(2026, 2, 10));
    });
});
