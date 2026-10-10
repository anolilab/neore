import { describe, expect, it } from "vitest";

import { canReadSkill, canWriteSkill, isMarketplaceSkill, isSkillOwner, skillVisibility } from "./access";

const owner = { organizationId: "org-a", userId: "owner" };
const orgMate = { organizationId: "org-a", organizationRole: "member", userId: "mate" };
const orgAdmin = { organizationId: "org-a", organizationRole: "admin", userId: "admin" };
const stranger = { organizationId: "org-b", userId: "stranger" };

describe("skill access", () => {
    it("treats a missing visibility as private", () => {
        expect(skillVisibility({ visibility: undefined })).toBe("private");
        expect(skillVisibility({ visibility: "something-else" })).toBe("private");
    });

    it("keeps a private skill private even when it carries the organization id", () => {
        // `createSkill` stamps the active organization onto private skills too —
        // the old check treated that as sharing.
        const skill = { organizationId: "org-a", userId: "owner", visibility: "private" };

        expect(canReadSkill(skill, owner)).toBe(true);
        expect(canReadSkill(skill, orgMate)).toBe(false);
        expect(canWriteSkill(skill, orgMate)).toBe(false);
        expect(canWriteSkill(skill, orgAdmin)).toBe(false);
        expect(canReadSkill(skill, stranger)).toBe(false);
        expect(isMarketplaceSkill(skill)).toBe(false);
    });

    it("shares an organization skill with that organization only", () => {
        const skill = { organizationId: "org-a", userId: "owner", visibility: "organization" };

        expect(canReadSkill(skill, orgMate)).toBe(true);
        expect(isSkillOwner(skill, orgMate)).toBe(false);
        expect(canReadSkill(skill, stranger)).toBe(false);
        expect(canReadSkill(skill, { userId: "mate" })).toBe(false);
        expect(isMarketplaceSkill(skill)).toBe(false);
    });

    it("lets only the owner and the organization's admins edit an organization skill", () => {
        const skill = { organizationId: "org-a", userId: "owner", visibility: "organization" };

        expect(canWriteSkill(skill, owner)).toBe(true);
        expect(canWriteSkill(skill, orgMate)).toBe(false);
        expect(canWriteSkill(skill, orgAdmin)).toBe(true);
        expect(canWriteSkill(skill, { ...orgMate, organizationRole: "owner" })).toBe(true);
        expect(canWriteSkill(skill, { ...orgMate, organizationRole: "member,admin" })).toBe(true);
        expect(canWriteSkill(skill, { ...orgMate, organizationRole: undefined })).toBe(false);
        // An admin of ANOTHER organization is a stranger here.
        expect(canWriteSkill(skill, { ...stranger, organizationRole: "admin" })).toBe(false);
    });

    it("lets anyone read a public skill but only the owner write it", () => {
        const skill = { organizationId: undefined, userId: "owner", visibility: "public" };

        expect(canReadSkill(skill, stranger)).toBe(true);
        expect(canWriteSkill(skill, stranger)).toBe(false);
        expect(canWriteSkill(skill, owner)).toBe(true);
        expect(isMarketplaceSkill(skill)).toBe(true);
    });

    it("rejects a null skill as a marketplace skill", () => {
        expect(isMarketplaceSkill(null)).toBe(false);
    });
});
