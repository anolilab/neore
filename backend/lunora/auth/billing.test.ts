/**
 * Billing boundaries: the tier and the credit allowance are what a customer
 * pays for, so granting either is platform-admin only (an organization owner
 * can be anyone who created an org), and the organization-scoped reads show a
 * plain member nothing about other members.
 *
 * Runs the real handlers on the in-memory harness. Only the session read and the
 * rate limiter are replaced; the platform-admin flag and each caller's role in
 * their active organization come from the `ADMINS` / `SESSIONS` maps below.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";

const { admins, sessionFrom, sessions } = vi.hoisted(() => {
    const adminIds = new Set<string>();
    const sessionByUser = new Map<string, { id: string; role: string } | null>();

    return {
        admins: adminIds,
        sessionFrom: async (context: { auth: { userId?: string | null } }) => {
            const { userId } = context.auth;

            return userId
                ? {
                      activeOrganization: sessionByUser.get(userId) ?? null,
                      email: `${userId}@example.com`,
                      id: userId,
                      isAdmin: adminIds.has(userId),
                      name: userId,
                      userId,
                  }
                : null;
        },
        sessions: sessionByUser,
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/rate-limiter")>()), rateLimitGuard: async () => undefined };
});

const { getMemberCredits, listMemberCredits, setMemberCreditOverride, setOrganizationBillingTier, updateBillingSettings } = await import("./billing");

const PLATFORM_ADMIN = "user-platform-admin";
const OWNER = "user-owner";
const ORG_ADMIN = "user-org-admin";
const MEMBER = "user-member";
const OUTSIDER = "user-outsider";

let harness: ReturnType<typeof lunoraTest>;
let orgId: string;
let otherOrgId: string;

const as = (userId: string) => harness.withIdentity({ userId } as never);

/** Inserts through the harness; the tables are `.global()` in production but plain shard tables here. */
const seed = async <T>(run: (db: any) => Promise<T>): Promise<T> => (await harness.run(async (ctx: any) => await run(ctx.db))) as T;

const insertOrganization = async (name: string, extra: Record<string, unknown> = {}): Promise<string> =>
    await seed(async (db) => await db.insert("organization", { createdAt: 1, name, slug: name.toLowerCase(), ...extra }));

const insertMember = async (userId: string, organizationId: string, role: string): Promise<string> =>
    await seed(async (db) => await db.insert("member", { createdAt: 1, organizationId, role, userId }));

const readOrganization = async (id: string): Promise<any> => await seed(async (db) => await db.organization.findFirst({ where: { _id: id } }));

const readCredits = async (organizationId: string, userId: string): Promise<any> =>
    await seed(async (db) => await db.memberCredits.findFirst({ where: { organizationId, userId } }));

const forbidden = { code: "FORBIDDEN" };

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    admins.clear();
    sessions.clear();

    orgId = await insertOrganization("Acme", { baseTier: "free" });
    otherOrgId = await insertOrganization("Other", { baseTier: "free" });

    await insertMember(OWNER, orgId, "owner");
    await insertMember(ORG_ADMIN, orgId, "admin");
    await insertMember(MEMBER, orgId, "member");
    await insertMember(OUTSIDER, otherOrgId, "owner");

    admins.add(PLATFORM_ADMIN);
    sessions.set(OWNER, { id: orgId, role: "owner" });
    sessions.set(ORG_ADMIN, { id: orgId, role: "admin" });
    sessions.set(MEMBER, { id: orgId, role: "member" });
    sessions.set(OUTSIDER, { id: otherOrgId, role: "owner" });
});

afterEach(() => {
    harness.close();
});

describe("setOrganizationBillingTier", () => {
    const args = (organizationId: string) => ({ baseTier: "enterprise", creditsPerUser: 5000, organizationId });

    it.each([OWNER, ORG_ADMIN, MEMBER, OUTSIDER])("refuses %s, who is not a platform admin, and leaves the tier alone", async (userId) => {
        await expect(as(userId).mutation(setOrganizationBillingTier as never, args(orgId) as never)).rejects.toMatchObject(forbidden);

        expect(await readOrganization(orgId)).toMatchObject({ baseTier: "free" });
        expect((await readOrganization(orgId)).creditsPerUser).toBeUndefined();
    });

    it("refuses an anonymous caller", async () => {
        await expect(harness.mutation(setOrganizationBillingTier as never, args(orgId) as never)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });

    it("lets a platform admin set the tier of any organization", async () => {
        await as(PLATFORM_ADMIN).mutation(setOrganizationBillingTier as never, args(otherOrgId) as never);

        expect(await readOrganization(otherOrgId)).toMatchObject({ baseTier: "enterprise", creditsPerUser: 5000 });
        expect(await readOrganization(orgId)).toMatchObject({ baseTier: "free" });
    });

    it("changes only the fields it is given", async () => {
        await as(PLATFORM_ADMIN).mutation(setOrganizationBillingTier as never, { baseTier: "pro", organizationId: orgId } as never);

        const org = await readOrganization(orgId);

        expect(org.baseTier).toBe("pro");
        expect(org.creditsPerUser).toBeUndefined();
    });

    it("rejects a negative allowance and an unknown tier before writing", async () => {
        await expect(as(PLATFORM_ADMIN).mutation(setOrganizationBillingTier as never, { creditsPerUser: -1, organizationId: orgId } as never)).rejects.toMatchObject({
            code: "VALIDATION_ERROR",
        });
        await expect(as(PLATFORM_ADMIN).mutation(setOrganizationBillingTier as never, { baseTier: "platinum", organizationId: orgId } as never)).rejects.toMatchObject({
            code: "VALIDATION_ERROR",
        });
        expect((await readOrganization(orgId)).creditsPerUser).toBeUndefined();
    });

    it("answers NOT_FOUND for an organization that does not exist", async () => {
        await seed(async (db) => {
            await db.delete(otherOrgId);
        });

        await expect(as(PLATFORM_ADMIN).mutation(setOrganizationBillingTier as never, args(otherOrgId) as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
});

describe("setMemberCreditOverride", () => {
    const args = (userId: string, creditOverride: number | null, organizationId = orgId) => ({ creditOverride, organizationId, userId });

    it.each([OWNER, ORG_ADMIN, MEMBER])("refuses %s, so nobody can grant themselves credits", async (userId) => {
        await expect(as(userId).mutation(setMemberCreditOverride as never, args(userId, 1_000_000) as never)).rejects.toMatchObject(forbidden);

        expect(await readCredits(orgId, userId)).toBeNull();
    });

    it("lets a platform admin create, change and clear an override", async () => {
        await as(PLATFORM_ADMIN).mutation(setMemberCreditOverride as never, args(MEMBER, 250) as never);
        expect(await readCredits(orgId, MEMBER)).toMatchObject({ creditOverride: 250, usedCredits: 0 });

        await as(PLATFORM_ADMIN).mutation(setMemberCreditOverride as never, args(MEMBER, 400) as never);
        expect((await readCredits(orgId, MEMBER)).creditOverride).toBe(400);

        await as(PLATFORM_ADMIN).mutation(setMemberCreditOverride as never, args(MEMBER, null) as never);
        expect((await readCredits(orgId, MEMBER)).creditOverride).toBeUndefined();
    });

    it("writes no row when clearing an override that was never set", async () => {
        await as(PLATFORM_ADMIN).mutation(setMemberCreditOverride as never, args(MEMBER, null) as never);

        expect(await readCredits(orgId, MEMBER)).toBeNull();
    });

    it("refuses a user who is not a member of that organization", async () => {
        await expect(as(PLATFORM_ADMIN).mutation(setMemberCreditOverride as never, args(OUTSIDER, 100) as never)).rejects.toMatchObject({ code: "NOT_FOUND" });

        expect(await readCredits(orgId, OUTSIDER)).toBeNull();
    });
});

describe("updateBillingSettings", () => {
    it.each([ORG_ADMIN, MEMBER])("refuses %s: only the owner edits billing preferences", async (userId) => {
        await expect(as(userId).mutation(updateBillingSettings as never, { billingEmail: "x@example.com" } as never)).rejects.toMatchObject(forbidden);

        expect((await readOrganization(orgId)).billingEmail).toBeUndefined();
    });

    it("lets the owner change the contact and model list, but never the tier", async () => {
        await as(OWNER).mutation(updateBillingSettings as never, { allowedModels: ["m1"], baseTier: "enterprise", billingEmail: "pay@example.com" } as never);

        expect(await readOrganization(orgId)).toMatchObject({ allowedModels: ["m1"], baseTier: "free", billingEmail: "pay@example.com" });
    });

    it("only ever writes to the caller's active organization", async () => {
        await as(OWNER).mutation(updateBillingSettings as never, { billingEmail: "pay@example.com" } as never);

        expect((await readOrganization(otherOrgId)).billingEmail).toBeUndefined();
    });

    it("refuses a caller with no active organization", async () => {
        sessions.set(OWNER, null);

        await expect(as(OWNER).mutation(updateBillingSettings as never, { billingEmail: "x@example.com" } as never)).rejects.toMatchObject(forbidden);
    });
});

describe("member credit reads", () => {
    it("shows a member their own balance", async () => {
        await expect(as(MEMBER).query(getMemberCredits as never, {} as never)).resolves.toMatchObject({ orgDefault: 100, usedCredits: 0, userId: MEMBER });
    });

    it("refuses a plain member another member's balance", async () => {
        await expect(as(MEMBER).query(getMemberCredits as never, { userId: OWNER } as never)).rejects.toMatchObject(forbidden);
    });

    it("lets an owner or org admin read another member's balance", async () => {
        await expect(as(OWNER).query(getMemberCredits as never, { userId: MEMBER } as never)).resolves.toMatchObject({ userId: MEMBER });
        await expect(as(ORG_ADMIN).query(getMemberCredits as never, { userId: MEMBER } as never)).resolves.toMatchObject({ userId: MEMBER });
    });

    it("lists member credits to owners and admins only, and only for the active organization", async () => {
        await expect(as(MEMBER).query(listMemberCredits as never, {} as never)).resolves.toEqual([]);

        const rows = (await as(OWNER).query(listMemberCredits as never, {} as never)) as { userId: string }[];

        expect(rows.map((row) => row.userId).sort()).toEqual([MEMBER, ORG_ADMIN, OWNER].sort());
    });

    it("returns nothing for a caller with no active organization", async () => {
        sessions.set(OWNER, null);

        await expect(as(OWNER).query(getMemberCredits as never, {} as never)).resolves.toBeNull();
        await expect(as(OWNER).query(listMemberCredits as never, {} as never)).resolves.toEqual([]);
    });
});
