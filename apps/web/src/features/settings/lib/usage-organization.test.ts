import { describe, expect, it, vi } from "vitest";

import { MAX_ORGANIZATION_PAGES, sumOrganizationUsage } from "./usage-organization";

const project = (projectKey: string, costMicrodollars: number) => {
    return { costMicrodollars, projectKey, replies: 1, title: projectKey, tokens: 10 };
};

describe("sumOrganizationUsage", () => {
    it("adds every page of members up per project, following the cursor", async () => {
        const fetchPage = vi.fn(async (after: string | undefined) =>
            after === undefined
                ? { members: 25, nextCursor: "u25", projects: [project("alpha", 100), project("beta", 10)], truncated: false }
                : { members: 3, projects: [project("alpha", 50), project("beta", 200)], truncated: false },
        );

        const result = await sumOrganizationUsage(fetchPage);

        expect(fetchPage.mock.calls.map(([after]) => after)).toStrictEqual([undefined, "u25"]);
        expect(result).toStrictEqual({
            members: 28,
            projects: [
                { costMicrodollars: 210, projectKey: "beta", replies: 2, title: "beta", tokens: 20 },
                { costMicrodollars: 150, projectKey: "alpha", replies: 2, title: "alpha", tokens: 20 },
            ],
            truncated: false,
        });
    });

    it("stops at the page cap and says the result is partial", async () => {
        const fetchPage = vi.fn(async () => {
            return { members: 1, nextCursor: "more", projects: [], truncated: false };
        });

        const result = await sumOrganizationUsage(fetchPage);

        expect(fetchPage).toHaveBeenCalledTimes(MAX_ORGANIZATION_PAGES);
        expect(result.truncated).toBe(true);
    });
});
