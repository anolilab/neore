import { describe, expect, it, vi } from "vitest";

import { MAX_ORGANIZATION_PAGES, OrganizationUsageTooLargeError, readOrganizationUsage } from "./usage-organization";

const totals = (costMicrodollars: number) => {
    return { costMicrodollars, replies: 1, tokens: 10 };
};

const RESULT = {
    complete: true,
    members: 28,
    noProject: totals(7),
    projects: [{ ...totals(140), projectKey: "alpha", title: "Alpha" }],
    total: totals(147),
    truncated: false,
};

describe("readOrganizationUsage", () => {
    it("follows the opaque cursor and returns only the final totals", async () => {
        const fetchStep = vi.fn(async (cursor: string | undefined) => (cursor === undefined ? { cursor: "sealed-1" } : { result: RESULT }));

        expect(await readOrganizationUsage(fetchStep)).toStrictEqual(RESULT);
        expect(fetchStep.mock.calls.map(([cursor]) => cursor)).toStrictEqual([undefined, "sealed-1"]);
    });

    it("gives up past the call cap", async () => {
        const fetchStep = vi.fn(async () => {
            return { cursor: "more" };
        });

        await expect(readOrganizationUsage(fetchStep)).rejects.toBeInstanceOf(OrganizationUsageTooLargeError);
        expect(fetchStep).toHaveBeenCalledTimes(MAX_ORGANIZATION_PAGES);
    });
});
