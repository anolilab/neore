import { TransportError } from "@lunora/client";
import { describe, expect, it, vi } from "vitest";

import { MAX_ORGANIZATION_PAGES, OrganizationUsageTooLargeError, readOrganizationUsage, retryOrganizationRead } from "./usage-organization";

const totals = (costMicrodollars: number) => {
    return { costMicrodollars, replies: 1, tokens: 10 };
};

const RESULT = {
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

describe("retryOrganizationRead", () => {
    it("tries once more only after a failure that may not repeat", () => {
        expect(retryOrganizationRead(0, new TypeError("Failed to fetch"))).toBe(true);
        expect(retryOrganizationRead(1, new TypeError("Failed to fetch"))).toBe(false);
        // A timeout reaches the client as a transport error, coded INTERNAL though no backend answered.
        expect(retryOrganizationRead(0, new TransportError("Request timed out"))).toBe(true);
        expect(retryOrganizationRead(1, new TransportError("Request timed out"))).toBe(false);
        expect(retryOrganizationRead(0, new OrganizationUsageTooLargeError("too large"))).toBe(false);
        const refused = Object.assign(new Error("Only organization admins"), { code: "FORBIDDEN", data: { code: "FORBIDDEN" } });

        expect(retryOrganizationRead(0, refused)).toBe(false);
    });
});
