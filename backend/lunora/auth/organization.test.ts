/**
 * The read procedures of `organization.ts` (`checkSlug`, `listOrganizations`,
 * `listUserInvitations`), and `assertOwnOrganizationId` as a real handler
 * (`prompts.createPrompt`) enforces it: a member sees only their own
 * memberships and invitations, and an `organizationId` from args that is not the
 * caller's active organization is refused.
 *
 * Runs on the in-memory harness; only the session read and the rate limiter are
 * replaced. The organization each caller has active comes from `SESSIONS`.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";

const { sessionFrom, sessions } = vi.hoisted(() => {
    const sessionByUser = new Map<string, { id: string; role: string } | null>();

    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) => {
            const { userId } = context.auth;

            return userId
                ? { activeOrganization: sessionByUser.get(userId) ?? null, email: `${userId}@example.com`, id: userId, isAdmin: false, name: userId, userId }
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

const { checkSlug, listOrganizations, listUserInvitations } = await import("./organization");
const { createPrompt } = await import("../prompts/functions");

const ALICE = "alice";
const BOB = "bob";

let harness: ReturnType<typeof lunoraTest>;
let acme: string;
let beta: string;
let gamma: string;

const as = (userId: string) => harness.withIdentity({ userId } as never);

/** Inserts through the harness; the tables are `.global()` in production but plain shard tables here. */
const seed = async <T>(run: (db: any) => Promise<T>): Promise<T> => (await harness.run(async (ctx: any) => await run(ctx.db))) as T;

const insertOrganization = async (name: string, extra: Record<string, unknown> = {}): Promise<string> =>
    await seed(async (db) => await db.insert("organization", { createdAt: 1, name, slug: name.toLowerCase(), ...extra }));

const insertMember = async (userId: string, organizationId: string, role = "member"): Promise<void> => {
    await seed(async (db) => await db.insert("member", { createdAt: 1, organizationId, role, userId }));
};

const insertInvitation = async (email: string, organizationId: string, extra: Record<string, unknown> = {}): Promise<string> =>
    await seed(
        async (db) =>
            await db.insert("invitation", { email, expiresAt: 9_999_999_999_999, inviterId: "inviter", organizationId, role: "member", status: "pending", ...extra }),
    );

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    sessions.clear();

    acme = await insertOrganization("Acme");
    beta = await insertOrganization("Beta", { logo: "https://example.com/beta.png" });
    gamma = await insertOrganization("Gamma");

    await insertMember(ALICE, acme, "owner");
    await insertMember(ALICE, beta, "member");
    await insertMember(BOB, gamma, "owner");

    sessions.set(ALICE, { id: acme, role: "owner" });
    sessions.set(BOB, { id: gamma, role: "owner" });
});

afterEach(() => {
    harness.close();
});

describe("checkSlug", () => {
    it("reports a taken slug as unavailable and a free one as available", async () => {
        await expect(as(ALICE).query(checkSlug as never, { slug: "acme" } as never)).resolves.toEqual({ available: false });
        await expect(as(ALICE).query(checkSlug as never, { slug: "brand-new" } as never)).resolves.toEqual({ available: true });
    });

    it("answers for a slug of an organization the caller is not in, but exposes nothing else", async () => {
        await expect(as(ALICE).query(checkSlug as never, { slug: "gamma" } as never)).resolves.toEqual({ available: false });
    });

    it("requires a signed-in caller", async () => {
        await expect(harness.query(checkSlug as never, { slug: "acme" } as never)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });
});

describe("listOrganizations", () => {
    it("lists the caller's other organizations, with ownership, and leaves the active one out", async () => {
        const result = (await as(ALICE).query(listOrganizations as never, {} as never)) as {
            canCreateOrganization: boolean;
            organizations: { id: string; isOwner: boolean; name: string; slug: string }[];
        };

        expect(result.canCreateOrganization).toBe(true);
        expect(result.organizations).toHaveLength(1);
        expect(result.organizations[0]).toMatchObject({ id: beta, isOwner: false, logo: "https://example.com/beta.png", name: "Beta", slug: "beta" });
    });

    it("never lists an organization the caller does not belong to", async () => {
        sessions.set(ALICE, null);

        const mine = (await as(ALICE).query(listOrganizations as never, {} as never)) as { organizations: { id: string }[] };
        const bobs = (await as(BOB).query(listOrganizations as never, {} as never)) as { organizations: { id: string }[] };

        expect(mine.organizations.map((org) => org.id).sort()).toEqual([acme, beta].sort());
        expect(bobs.organizations).toEqual([]);
        expect(mine.organizations.map((org) => org.id)).not.toContain(gamma);
    });

    it("answers a user with no membership with an empty list that can still create one", async () => {
        await expect(as("stranger").query(listOrganizations as never, {} as never)).resolves.toEqual({ canCreateOrganization: true, organizations: [] });
    });

    it("requires a signed-in caller", async () => {
        await expect(harness.query(listOrganizations as never, {} as never)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });
});

describe("listUserInvitations", () => {
    it("lists only pending invitations addressed to the caller's own email", async () => {
        const mine = await insertInvitation(`${ALICE}@example.com`, gamma, { role: "admin" });

        await insertInvitation(`${BOB}@example.com`, acme);
        await insertInvitation(`${ALICE}@example.com`, beta, { status: "rejected" });

        const result = (await as(ALICE).query(listUserInvitations as never, {} as never)) as { id: string }[];

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ id: mine, inviterName: null, organizationName: "Gamma", organizationSlug: "gamma", role: "admin" });
    });

    it("never shows another user's invitations", async () => {
        await insertInvitation(`${BOB}@example.com`, acme);

        await expect(as(ALICE).query(listUserInvitations as never, {} as never)).resolves.toEqual([]);
    });

    it("drops an invitation whose organization no longer exists", async () => {
        const orphan = await insertOrganization("Gone");

        await insertInvitation(`${ALICE}@example.com`, orphan);
        await seed(async (db) => {
            await db.delete(orphan);
        });

        await expect(as(ALICE).query(listUserInvitations as never, {} as never)).resolves.toEqual([]);
    });
});

describe("assertOwnOrganizationId in createPrompt", () => {
    // The allowed path is not driven here: `createPrompt` then calls `runMutation(internal.lib.action_cache.remove)`,
    // which needs the generated function registry the in-memory harness does not load.
    // `lib/organization-helpers.test.ts` covers the accepting branches of the assertion itself.
    const prompt = (organizationId: string) => ({ content: "Hello", name: "Greeting", organizationId });

    const promptRows = async (): Promise<{ organizationId?: string; userId: string }[]> =>
        await seed(async (db) => {
            const { page } = await db.prompts.findMany({});

            return page;
        });

    it("refuses another organization's id, even one the caller belongs to but has not made active", async () => {
        await expect(as(ALICE).mutation(createPrompt as never, prompt(gamma) as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(as(ALICE).mutation(createPrompt as never, prompt(beta) as never)).rejects.toMatchObject({ code: "FORBIDDEN" });

        expect(await promptRows()).toEqual([]);
    });

    it("refuses every organization when the caller has none active", async () => {
        sessions.set(ALICE, null);

        await expect(as(ALICE).mutation(createPrompt as never, prompt(acme) as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
});
