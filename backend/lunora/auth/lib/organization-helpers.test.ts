import { describe, expect, it } from "vitest";

import { assertOwnOrganizationId } from "./organization-helpers";

const forbidden = expect.objectContaining({ code: "FORBIDDEN" });

describe("assertOwnOrganizationId", () => {
    const member = { activeOrganization: { id: "org-a" } };

    it("passes a personal row (no organization)", () => {
        expect(() => assertOwnOrganizationId(member, undefined)).not.toThrow();
        expect(() => assertOwnOrganizationId(member, null)).not.toThrow();
        expect(() => assertOwnOrganizationId({ activeOrganization: null }, undefined)).not.toThrow();
    });

    it("passes the caller's active organization", () => {
        expect(() => assertOwnOrganizationId(member, "org-a")).not.toThrow();
    });

    it("refuses any other organization", () => {
        expect(() => assertOwnOrganizationId(member, "org-b")).toThrow(forbidden);
    });

    it("refuses every organization when the caller has no active one", () => {
        expect(() => assertOwnOrganizationId({ activeOrganization: null }, "org-a")).toThrow(forbidden);
        expect(() => assertOwnOrganizationId({}, "org-a")).toThrow(forbidden);
    });
});
