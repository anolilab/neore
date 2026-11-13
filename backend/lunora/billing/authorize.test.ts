/**
 * Who `ctx.payments` lets bill a reference: the caller's own user id, or an organization the
 * `member` table says they own. The session's role is not consulted.
 */
import { describe, expect, it } from "vitest";

import { authorizeBilling } from "./authorize";

const OWNER = "user-owner";
const MEMBER = "user-member";
const ORG = "org-1";

const members = [
    { organizationId: ORG, role: "owner", userId: OWNER },
    { organizationId: ORG, role: "member", userId: MEMBER },
];

const db = {
    findFirst: async (table: string, args?: { where?: Record<string, unknown> }) => {
        if (table !== "member") {
            throw new Error(`unexpected table ${table}`);
        }

        const where = args?.where ?? {};

        return members.find((row) => row.organizationId === where["organizationId"] && row.userId === where["userId"]) ?? null;
    },
} as unknown as Parameters<typeof authorizeBilling>[1]["db"];

describe("authorizeBilling", () => {
    it("lets a caller bill their own user id", async () => {
        await expect(authorizeBilling(MEMBER, { db, userId: MEMBER })).resolves.toBe(true);
    });

    it("lets an owner bill their organization", async () => {
        await expect(authorizeBilling(ORG, { db, userId: OWNER })).resolves.toBe(true);
    });

    it("refuses a member who does not own the organization", async () => {
        await expect(authorizeBilling(ORG, { db, userId: MEMBER })).resolves.toBe(false);
    });

    it("refuses another user's id and an organization the caller is not in", async () => {
        await expect(authorizeBilling(OWNER, { db, userId: MEMBER })).resolves.toBe(false);
        await expect(authorizeBilling("org-2", { db, userId: OWNER })).resolves.toBe(false);
    });

    it("refuses a caller who is not signed in", async () => {
        await expect(authorizeBilling(ORG, { db, userId: undefined })).resolves.toBe(false);
    });
});
