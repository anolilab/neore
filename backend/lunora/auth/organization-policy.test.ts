/**
 * The organization policy procedures: only the owner of the active organization
 * writes, any member of it reads, an invalid document is never stored, and a
 * deleted organization's row is removed.
 *
 * Runs on the in-memory harness. The organization role of each caller comes
 * from the `SESSIONS` map below, as in `team.test.ts`.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jobsQueueMessages } from "../../test/stubs/cloudflare-workers";
import { claimOnce, ORGANIZATION_POLICY_CREATE_CLAIM_TTL_MS, ORGANIZATION_POLICY_CREATE_SCOPE } from "../lib/claim-once";
import schema from "../schema";

const OWNER = "user-owner";
const ADMIN = "user-admin";
const MEMBER = "user-member";
const OUTSIDER = "user-outsider";
const ORG = "org-1";
const OTHER_ORG = "org-2";

const { sessionFrom, sessions, staleRead } = vi.hoisted(() => {
    const sessionByUser = new Map<string, { id: string; role: string } | null>();

    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) => {
            const { userId } = context.auth;

            return userId
                ? { activeOrganization: sessionByUser.get(userId) ?? null, email: `${userId}@example.com`, id: userId, isAdmin: false, name: userId, userId }
                : null;
        },
        sessions: sessionByUser,
        // Set by a test to the policy row as an earlier read saw it; the next policy read in a mutation answers with it.
        staleRead: { current: undefined as undefined | object },
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

// The harness runs each mutation in its own transaction, one after another, so it cannot interleave two writers the way
// two shards do. A writer that read a row which another writer then changed is simulated instead: the guard receives the
// mutation's live `ctx.db`, and where a test set `staleRead`, that mutation's policy read answers with the older row
// while the database already holds the newer one.
vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async (context: any) => {
            const stale = staleRead.current;

            if (!stale || context.rateLimitKey !== "organization/policy") {
                return;
            }

            staleRead.current = undefined;
            context.db.organizationPolicies.findFirst = async () => stale;
        },
    };
});

const { getOrganizationPolicy, setOrganizationPolicy } = await import("./organization-policy");
const { deleteOrganizationPolicy, queueOrganizationPolicyErase, sweepOrphanedOrganizationPolicies, sweepOrphanedPolicyPage } =
    await import("./organization-policy-erase");

let harness: ReturnType<typeof lunoraTest>;

const as = (userId: string) => harness.withIdentity({ userId } as never);

const seed = async <T>(run: (db: any) => Promise<T>): Promise<T> => (await harness.run(async (ctx: any) => await run(ctx.db))) as T;

const rowsOf = async (organizationId: string): Promise<{ _id: string; document: string; revision: number }[]> =>
    await seed(async (db) => {
        const { page } = await db.organizationPolicies.findMany({ where: { organizationId } });

        return page;
    });

const write = async (userId: string, policy: unknown) =>
    await as(userId).mutation(setOrganizationPolicy as never, { document: typeof policy === "string" ? policy : JSON.stringify(policy) } as never);

const read = async (userId: string) => await as(userId).query(getOrganizationPolicy as never, {} as never);

const eraseOf = async (organizationId: string): Promise<unknown> =>
    await harness.run(async (context: any) => await context.runMutation(deleteOrganizationPolicy, { organizationId }));

const forbidden = { code: "FORBIDDEN" };

const POLICY = { models: { allowed: ["model-a"] }, permissionCap: "ask", schemaVersion: 1, settings: { memoryEnabled: { locked: true, value: false } } };

beforeEach(() => {
    harness = lunoraTest(schema as never);
    sessions.clear();
    staleRead.current = undefined;
    sessions.set(OWNER, { id: ORG, role: "owner" });
    sessions.set(ADMIN, { id: ORG, role: "admin" });
    sessions.set(MEMBER, { id: ORG, role: "member" });
    sessions.set(OUTSIDER, { id: OTHER_ORG, role: "member" });
    jobsQueueMessages.length = 0;
});

afterEach(() => {
    harness.close();
});

describe("setOrganizationPolicy", () => {
    it("lets the owner store a policy in the active organization", async () => {
        await expect(write(OWNER, POLICY)).resolves.toEqual({ revision: 1 });

        const rows = await rowsOf(ORG);

        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0]!.document)).toEqual(POLICY);
        expect(await rowsOf(OTHER_ORG)).toHaveLength(0);
    });

    it.each([ADMIN, MEMBER])("refuses %s: only the owner writes", async (userId) => {
        await expect(write(userId, POLICY)).rejects.toMatchObject(forbidden);

        expect(await rowsOf(ORG)).toHaveLength(0);
    });

    it("writes only to the caller's own active organization", async () => {
        sessions.set(OUTSIDER, { id: OTHER_ORG, role: "owner" });

        await write(OUTSIDER, POLICY);

        expect(await rowsOf(ORG)).toHaveLength(0);
        expect(await rowsOf(OTHER_ORG)).toHaveLength(1);
    });

    it("refuses a caller with no active organization", async () => {
        sessions.set(OWNER, null);

        await expect(write(OWNER, POLICY)).rejects.toMatchObject(forbidden);
    });

    it("refuses an anonymous caller", async () => {
        await expect(harness.mutation(setOrganizationPolicy as never, { document: JSON.stringify(POLICY) } as never)).rejects.toBeDefined();
    });

    it("patches the same row on a second write and moves the revision", async () => {
        await write(OWNER, POLICY);
        await expect(write(OWNER, { schemaVersion: 1 })).resolves.toEqual({ revision: 2 });

        const rows = await rowsOf(ORG);

        expect(rows).toHaveLength(1);
        expect(rows[0]!.revision).toBe(2);
        expect(JSON.parse(rows[0]!.document)).toEqual({ schemaVersion: 1 });
    });

    it("updates an unchanged row and moves its revision by one", async () => {
        await write(OWNER, POLICY);

        const [before] = await rowsOf(ORG);

        await expect(write(OWNER, { permissionCap: "off", schemaVersion: 1 })).resolves.toEqual({ revision: before!.revision + 1 });

        const rows = await rowsOf(ORG);

        expect(rows).toHaveLength(1);
        expect(rows[0]!.revision).toBe(2);
        expect(JSON.parse(rows[0]!.document)).toEqual({ permissionCap: "off", schemaVersion: 1 });
    });

    it("refuses a stale update with CONFLICT and keeps the newer document", async () => {
        await write(OWNER, POLICY);

        const [stale] = await rowsOf(ORG);
        const newer = JSON.stringify({ permissionCap: "off", schemaVersion: 1 });

        // Another owner's write commits after this writer read revision 1 and before it writes.
        await seed(async (db) => {
            await db.patch("organizationPolicies", stale!._id, { document: newer, revision: 2 });
        });
        staleRead.current = stale;

        await expect(write(OWNER, { permissionCap: "auto", schemaVersion: 1 })).rejects.toMatchObject({ code: "CONFLICT" });

        const rows = await rowsOf(ORG);

        expect(rows).toHaveLength(1);
        expect(rows[0]!.revision).toBe(2);
        expect(rows[0]!.document).toBe(newer);
        expect(staleRead.current).toBeUndefined();
    });

    // The harness runs each mutation in its own transaction, so it cannot interleave two writers the way two shards do;
    // the interleaving itself is covered by the held-claim test below.
    it("leaves one row when two first writes run at once, the loser updating or being told to retry", async () => {
        const results = await Promise.allSettled([write(OWNER, POLICY), write(OWNER, { permissionCap: "off", schemaVersion: 1 })]);

        expect(results.some((result) => result.status === "fulfilled")).toBe(true);

        for (const result of results) {
            if (result.status === "rejected") {
                expect(result.reason).toMatchObject({ code: "CONFLICT" });
            }
        }

        expect(await rowsOf(ORG)).toHaveLength(1);
    });

    it("answers CONFLICT, and inserts nothing, when another writer holds the create claim and no row exists yet", async () => {
        await harness.run(async (ctx: any) => {
            await claimOnce(ctx, ORGANIZATION_POLICY_CREATE_SCOPE, ORG, ORGANIZATION_POLICY_CREATE_CLAIM_TTL_MS);
        });

        await expect(write(OWNER, POLICY)).rejects.toMatchObject({ code: "CONFLICT" });

        expect(await rowsOf(ORG)).toHaveLength(0);
    });

    it("patches an existing row even while the create claim is still held", async () => {
        await write(OWNER, POLICY);

        await expect(write(OWNER, { schemaVersion: 1 })).resolves.toEqual({ revision: 2 });

        expect(await rowsOf(ORG)).toHaveLength(1);
    });

    it("takes no create claim for a document that is rejected", async () => {
        await expect(write(OWNER, { schemaVersion: 2 })).rejects.toMatchObject({ code: "BAD_REQUEST" });

        await expect(write(OWNER, POLICY)).resolves.toEqual({ revision: 1 });
    });

    it("stores canonical text, whatever the input key order or spacing", async () => {
        await write(OWNER, '{ "permissionCap": "off", "schemaVersion": 1 }');

        const [row] = await rowsOf(ORG);

        expect(row!.document).toBe('{"schemaVersion":1,"permissionCap":"off"}');
    });

    it.each([
        ["an unknown key", { schemaVersion: 1, unknown: true }],
        ["an unknown schemaVersion", { schemaVersion: 2 }],
        ["a wrong type", { permissionCap: 3, schemaVersion: 1 }],
        ["a lock on a key that is not managed", { schemaVersion: 1, settings: { selectedModel: { locked: true, value: true } } }],
        ["text that is not JSON", "{"],
    ])("rejects %s and leaves the stored policy as it was", async (_name, bad) => {
        await write(OWNER, POLICY);

        await expect(write(OWNER, bad)).rejects.toMatchObject({ code: "BAD_REQUEST" });

        const rows = await rowsOf(ORG);

        expect(rows).toHaveLength(1);
        expect(rows[0]!.revision).toBe(1);
        expect(JSON.parse(rows[0]!.document)).toEqual(POLICY);
    });

    it("stores nothing for a first write that is invalid", async () => {
        await expect(write(OWNER, { schemaVersion: 2 })).rejects.toMatchObject({ code: "BAD_REQUEST" });

        expect(await rowsOf(ORG)).toHaveLength(0);
    });
});

describe("getOrganizationPolicy", () => {
    it.each([OWNER, ADMIN, MEMBER])("lets %s of the organization read the policy and its revision", async (userId) => {
        await write(OWNER, POLICY);

        expect(await read(userId)).toMatchObject({ policy: POLICY, revision: 1 });
    });

    it("answers null while the organization has set none", async () => {
        expect(await read(MEMBER)).toBeNull();
    });

    it("never shows another organization's policy", async () => {
        await write(OWNER, POLICY);

        expect(await read(OUTSIDER)).toBeNull();
    });

    it("answers null with no active organization", async () => {
        await write(OWNER, POLICY);
        sessions.set(MEMBER, null);

        expect(await read(MEMBER)).toBeNull();
    });

    it("follows a rewrite", async () => {
        await write(OWNER, POLICY);
        await write(OWNER, { permissionCap: "off", schemaVersion: 1 });

        expect(await read(MEMBER)).toMatchObject({ policy: { permissionCap: "off", schemaVersion: 1 }, revision: 2 });
    });
});

describe("removing a deleted organization's policy", () => {
    it("deletes that organization's row and no other", async () => {
        await write(OWNER, POLICY);
        sessions.set(OUTSIDER, { id: OTHER_ORG, role: "owner" });
        await write(OUTSIDER, POLICY);

        await eraseOf(ORG);

        expect(await rowsOf(ORG)).toHaveLength(0);
        expect(await rowsOf(OTHER_ORG)).toHaveLength(1);
    });

    it("is a no-op for an organization without a policy, so a redelivery is harmless", async () => {
        await expect(eraseOf(ORG)).resolves.toBeNull();
    });

    it("is queued on __root__", async () => {
        await queueOrganizationPolicyErase(ORG);

        expect(jobsQueueMessages).toStrictEqual([
            { body: { args: { organizationId: ORG }, functionPath: "auth_organization_policy_erase:deleteOrganizationPolicy", shardKey: "__root__" } },
        ]);
    });
});

describe("the reconciliation sweep for policies of deleted organizations", () => {
    const sweep = async (): Promise<void> => {
        await harness.run(async (context: any) => await context.runMutation(sweepOrphanedOrganizationPolicies, {}));
    };

    const insertPolicy = async (organizationId: string, revision = 1): Promise<void> => {
        await seed(async (db) => {
            await db.insert("organizationPolicies", { document: "{}", organizationId, revision, schemaVersion: 1, updatedAt: 1 });
        });
    };

    /** Creates a real organization row and returns the id a policy row names. */
    const insertOrganization = async (name: string): Promise<string> =>
        await seed(async (db) => await db.insert("organization", { createdAt: 1, name, slug: name }));

    /** Delete audits for policy rows, as the audit trigger writes them. */
    const policyDeleteAudits = async (): Promise<unknown[]> =>
        await seed(async (db) => {
            const { page } = await db.documentHistory.findMany({ where: { isDeleted: true, tableName: "organizationPolicies" } });

            return page;
        });

    it("removes a policy whose organization no longer exists and keeps one whose organization does", async () => {
        const existing = await insertOrganization("kept-org");

        await insertPolicy(existing);
        await insertPolicy("deleted-org");

        await sweep();

        expect(await rowsOf(existing)).toHaveLength(1);
        expect(await rowsOf("deleted-org")).toHaveLength(0);
        expect(await policyDeleteAudits()).toHaveLength(1);
    });

    it("deletes nothing and writes no audit row on a second run", async () => {
        const existing = await insertOrganization("kept-org");

        await insertPolicy(existing);
        await insertPolicy("deleted-org");
        await sweep();

        const auditsAfterFirst = await policyDeleteAudits();

        await sweep();

        expect(await rowsOf(existing)).toHaveLength(1);
        expect(await policyDeleteAudits()).toHaveLength(auditsAfterFirst.length);
    });

    it("keeps a policy whose organization could not be read", async () => {
        await insertPolicy("deleted-org");

        const deleted = await harness.run(async (context: any) => {
            const failing = new Proxy(context.db, {
                get: (target, property, receiver) =>
                    property === "organization"
                        ? {
                              findFirst: async () => {
                                  throw new Error("organization read failed");
                              },
                          }
                        : Reflect.get(target, property, receiver),
            });

            const result = await sweepOrphanedPolicyPage(failing, undefined);

            return result.deleted;
        });

        expect(deleted).toBe(0);
        expect(await rowsOf("deleted-org")).toHaveLength(1);
        expect(await policyDeleteAudits()).toHaveLength(0);
    });

    it("leaves a row rewritten since it was read", async () => {
        await insertPolicy("deleted-org");

        const deleted = await harness.run(async (context: any) => {
            const rewriting = new Proxy(context.db, {
                get: (target, property, receiver) =>
                    property === "organization"
                        ? {
                              findFirst: async () => {
                                  const { page } = await target.organizationPolicies.findMany({ where: { organizationId: "deleted-org" } });
                                  const [row] = page;

                                  await target.patch("organizationPolicies", row._id, { revision: row.revision + 1 });

                                  return null;
                              },
                          }
                        : Reflect.get(target, property, receiver),
            });

            const result = await sweepOrphanedPolicyPage(rewriting, undefined);

            return result.deleted;
        });

        expect(deleted).toBe(0);
        expect(await rowsOf("deleted-org")).toHaveLength(1);
    });
});
