import { describe, expect, it, vi } from "vitest";

import type { OrganizationUsagePage } from "./usage-organization";
import { MAX_ORGANIZATION_PAGES, startOfDayInZone, sumOrganizationUsage } from "./usage-organization";

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

describe("the day an organization period starts at", () => {
    it("is midnight in the viewer's zone", () => {
        expect(startOfDayInZone("2026-03-10", "UTC")).toBe(Date.UTC(2026, 2, 10));
        // New York is on daylight time from 8 March 2026: its midnight is four hours past UTC's.
        expect(startOfDayInZone("2026-03-10", "America/New_York")).toBe(Date.UTC(2026, 2, 10, 4));
        // Tokyo is nine hours ahead: its midnight is the afternoon before, in UTC.
        expect(startOfDayInZone("2026-03-10", "Asia/Tokyo")).toBe(Date.UTC(2026, 2, 9, 15));
    });

    it("holds on the day daylight time starts, when the offset changes", () => {
        // New York's clocks change at 2am on 8 March 2026; midnight that day is still on standard time, five hours past UTC.
        expect(startOfDayInZone("2026-03-08", "America/New_York")).toBe(Date.UTC(2026, 2, 8, 5));
    });
});

describe("the day an organization period starts at, in the zones that are hard to count", () => {
    it("starts at the change when a zone moves its clocks at midnight, and does not take the day before", () => {
        // Santiago's clocks jump from midnight to one o'clock on 6 September 2026, so the day starts at the change, four hours past UTC.
        expect(startOfDayInZone("2026-09-06", "America/Santiago")).toBe(Date.UTC(2026, 8, 6, 4));
        // The day after is on daylight time: its midnight is three hours past UTC.
        expect(startOfDayInZone("2026-09-07", "America/Santiago")).toBe(Date.UTC(2026, 8, 7, 3));
    });

    it("counts a zone the runtime does not know as UTC, rather than failing the view", () => {
        expect(startOfDayInZone("2026-03-10", "Not/AZone")).toBe(Date.UTC(2026, 2, 10));
    });
});
