import { describe, expect, it } from "vitest";

import { isOrganizationAdminRole } from "./organization";

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
