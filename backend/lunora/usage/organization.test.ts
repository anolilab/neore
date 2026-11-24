import { describe, expect, it } from "vitest";

import { isOrganizationAdminRole, organizationPeriodEnd, organizationPeriodStart } from "./organization";

describe("the organization usage view's admin check", () => {
    it("grants the view to an admin or an owner", () => {
        expect(isOrganizationAdminRole("admin")).toBe(true);
        expect(isOrganizationAdminRole("owner")).toBe(true);
    });

    it("does not grant it to a member", () => {
        expect(isOrganizationAdminRole("member")).toBe(false);
        expect(isOrganizationAdminRole("")).toBe(false);
    });

    it("reads a comma-separated list of roles, granting the view when one of them is an admin role", () => {
        expect(isOrganizationAdminRole("member, admin")).toBe(true);
        expect(isOrganizationAdminRole("member,owner")).toBe(true);
        expect(isOrganizationAdminRole("member,viewer")).toBe(false);
    });
});

describe("the organization view's period", () => {
    const DAY = 24 * 60 * 60 * 1000;

    it("reads the last closed week when the period starts in a week not yet closed, as the last seven days do on a Sunday", () => {
        // Sunday 2026-11-22 12:00 UTC: the last seven days start on Monday 2026-11-16, the open week.
        const now = Date.UTC(2026, 10, 22, 12);
        const until = organizationPeriodEnd(now);
        const from = organizationPeriodStart(now - 6 * DAY, until);

        expect(until).toBe(Date.UTC(2026, 10, 16));
        expect(from).toBe(Date.UTC(2026, 10, 9));
    });

    it("still starts on the Monday of an earlier `since`", () => {
        const now = Date.UTC(2026, 10, 22, 12);

        expect(organizationPeriodStart(Date.UTC(2026, 9, 28), organizationPeriodEnd(now))).toBe(Date.UTC(2026, 9, 26));
    });
});
