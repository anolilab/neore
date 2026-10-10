import { describe, expect, it } from "vitest";

import {
    assertBetterAuthUser,
    extractUserId,
    hasBetterAuthId,
    isBetterAuthInvitation,
    isBetterAuthMember,
    isBetterAuthOrganization,
    isBetterAuthUser,
} from "./type-guards";

describe("isBetterAuthUser", () => {
    it("should return true for valid user objects", () => {
        expect(isBetterAuthUser({ _id: "user_123", email: "test@example.com", name: "Test" })).toBe(true);
    });

    it("should return true with optional fields", () => {
        expect(
            isBetterAuthUser({
                _id: "user_123",
                activeOrganization: { id: "org_1", name: "Org", role: "admin" },
                email: "test@example.com",
                name: "Test",
                role: "admin",
            }),
        ).toBe(true);
    });

    it("should return false for null/undefined", () => {
        expect(isBetterAuthUser(null)).toBe(false);
        expect(isBetterAuthUser(undefined)).toBe(false);
    });

    it("should return false for non-objects", () => {
        expect(isBetterAuthUser("string")).toBe(false);
        expect(isBetterAuthUser(42)).toBe(false);
        expect(isBetterAuthUser(true)).toBe(false);
    });

    it("should return false when missing required fields", () => {
        expect(isBetterAuthUser({ _id: "user_123" })).toBe(false);
        expect(isBetterAuthUser({ email: "test@example.com" })).toBe(false);
        expect(isBetterAuthUser({})).toBe(false);
    });

    it("should return false when fields have wrong types", () => {
        expect(isBetterAuthUser({ _id: 123, email: "test@example.com" })).toBe(false);
        expect(isBetterAuthUser({ _id: "user_123", email: 456 })).toBe(false);
    });
});

describe("assertBetterAuthUser", () => {
    it("should not throw for valid user objects", () => {
        expect(() => assertBetterAuthUser({ _id: "user_123", email: "test@example.com" })).not.toThrow();
    });

    it("should throw for invalid user objects", () => {
        expect(() => assertBetterAuthUser(null)).toThrow();
        expect(() => assertBetterAuthUser({})).toThrow();
        expect(() => assertBetterAuthUser({ _id: "123" })).toThrow();
    });
});

describe("hasBetterAuthId", () => {
    it("should return true for objects with string _id", () => {
        expect(hasBetterAuthId({ _id: "user_123" })).toBe(true);
        expect(hasBetterAuthId({ _id: "abc", other: "field" })).toBe(true);
    });

    it("should return false for missing or non-string _id", () => {
        expect(hasBetterAuthId({})).toBe(false);
        expect(hasBetterAuthId({ _id: 123 })).toBe(false);
        expect(hasBetterAuthId(null)).toBe(false);
        expect(hasBetterAuthId(undefined)).toBe(false);
        expect(hasBetterAuthId("string")).toBe(false);
    });
});

describe("extractUserId", () => {
    it("should extract _id (document id format)", () => {
        expect(extractUserId({ _id: "user_lunora" })).toBe("user_lunora");
    });

    it("should fall back to id (Better Auth format)", () => {
        expect(extractUserId({ id: "user_ba" })).toBe("user_ba");
    });

    it("should prefer _id over id", () => {
        expect(extractUserId({ _id: "lunora", id: "ba" })).toBe("lunora");
    });

    it("should return null for invalid inputs", () => {
        expect(extractUserId(null)).toBeNull();
        expect(extractUserId(undefined)).toBeNull();
        expect(extractUserId({})).toBeNull();
        expect(extractUserId("string")).toBeNull();
        expect(extractUserId({ _id: 123 })).toBeNull();
    });
});

describe("isBetterAuthOrganization", () => {
    const validOrg = { _id: "org_1", monthlyCredits: 100, name: "My Org" };

    it("should return true for valid org objects", () => {
        expect(isBetterAuthOrganization(validOrg)).toBe(true);
    });

    it("should return false for missing fields", () => {
        expect(isBetterAuthOrganization({ _id: "org_1", name: "Org" })).toBe(false);
        expect(isBetterAuthOrganization({ _id: "org_1", monthlyCredits: 100 })).toBe(false);
        expect(isBetterAuthOrganization({ monthlyCredits: 100, name: "Org" })).toBe(false);
    });

    it("should return false for wrong types", () => {
        expect(isBetterAuthOrganization({ _id: "org_1", monthlyCredits: "100", name: "Org" })).toBe(false);
        expect(isBetterAuthOrganization(null)).toBe(false);
    });
});

describe("isBetterAuthMember", () => {
    const validMember = { _id: "mem_1", organizationId: "org_1", role: "admin", userId: "user_1" };

    it("should return true for valid member objects", () => {
        expect(isBetterAuthMember(validMember)).toBe(true);
    });

    it("should return false for missing fields", () => {
        expect(isBetterAuthMember({ _id: "mem_1", organizationId: "org_1", userId: "user_1" })).toBe(false);
        expect(isBetterAuthMember({ _id: "mem_1" })).toBe(false);
    });

    it("should return false for non-objects", () => {
        expect(isBetterAuthMember(null)).toBe(false);
        expect(isBetterAuthMember(undefined)).toBe(false);
    });
});

describe("isBetterAuthInvitation", () => {
    const validInvitation = {
        _id: "inv_1",
        email: "invite@example.com",
        organizationId: "org_1",
        status: "pending",
    };

    it("should return true for valid invitation with pending status", () => {
        expect(isBetterAuthInvitation(validInvitation)).toBe(true);
    });

    it("should return true for all valid statuses", () => {
        for (const status of ["pending", "accepted", "rejected", "canceled"]) {
            expect(isBetterAuthInvitation({ ...validInvitation, status })).toBe(true);
        }
    });

    it("should return false for invalid status", () => {
        expect(isBetterAuthInvitation({ ...validInvitation, status: "expired" })).toBe(false);
        expect(isBetterAuthInvitation({ ...validInvitation, status: "" })).toBe(false);
    });

    it("should return false for missing fields", () => {
        expect(isBetterAuthInvitation({ _id: "inv_1", email: "a@b.com" })).toBe(false);
        expect(isBetterAuthInvitation(null)).toBe(false);
    });
});
