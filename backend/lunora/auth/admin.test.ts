/**
 * Platform-admin boundary: `adminQuery` / `adminMutation` refuse a caller whose
 * session is not `isAdmin`, and the handlers keep an admin from locking
 * themselves out or acting on another admin.
 *
 * Runs the real handlers on the in-memory harness. Only the session read (the
 * better-auth lookup) and the rate limiter are replaced; `isAdmin` comes from the
 * `ADMINS` set below, the way production derives it from `user.role`.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";

const { admins, sessionFrom } = vi.hoisted(() => {
    const adminIds = new Set<string>();

    return {
        admins: adminIds,
        sessionFrom: async (context: { auth: { userId?: string | null } }) => {
            const { userId } = context.auth;

            return userId
                ? { activeOrganization: null, email: `${userId}@example.com`, id: userId, isAdmin: adminIds.has(userId), name: userId, userId }
                : null;
        },
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

const {
    banUser,
    checkUserAdminStatus,
    getAllUsers,
    getDashboardStats,
    grantAdminByEmail,
    isCurrentUserAdmin,
    revokeAdminByEmail,
    revokeAllUserSessions,
    unbanUser,
    updateUserRole,
} = await import("./admin");

let harness: ReturnType<typeof lunoraTest>;

/** The session id of the caller; every user row's `_id` is also its session `userId`. */
const as = (userId: string) => harness.withIdentity({ userId } as never);

/** Inserts through the harness; `user` is `.global()` in production but a plain shard table here. */
const seed = async <T>(run: (db: any) => Promise<T>): Promise<T> => (await harness.run(async (ctx: any) => await run(ctx.db))) as T;

const insertUser = async (email: string, role?: string): Promise<string> =>
    await seed(async (db) => await db.insert("user", { createdAt: 1, email, emailVerified: true, name: email, updatedAt: 1, ...(role && { role }) }));

const readUser = async (userId: string): Promise<any> => await seed(async (db) => await db.user.findFirst({ where: { _id: userId } }));

const auditActions = async (): Promise<string[]> =>
    await seed(async (db) => {
        const { page } = await db.auditLog.findMany({});

        return page.map((row: { action: string }) => row.action);
    });

let adminId: string;
let otherAdminId: string;
let memberId: string;

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    admins.clear();

    adminId = await insertUser("admin@example.com", "admin");
    otherAdminId = await insertUser("other-admin@example.com", "admin");
    memberId = await insertUser("member@example.com");
    admins.add(adminId);
    admins.add(otherAdminId);
});

afterEach(() => {
    harness.close();
});

const forbidden = { code: "FORBIDDEN" };

describe("the platform-admin gate", () => {
    it("refuses an anonymous caller", async () => {
        await expect(harness.query(checkUserAdminStatus as never, { userId: memberId } as never)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });

    it.each([
        ["checkUserAdminStatus", () => as(memberId).query(checkUserAdminStatus as never, { userId: otherAdminId } as never)],
        ["getAllUsers", () => as(memberId).query(getAllUsers as never, {} as never)],
        ["getDashboardStats", () => as(memberId).query(getDashboardStats as never, { now: 1000 } as never)],
    ])("refuses a non-admin on the query %s", async (_name, call) => {
        await expect(call()).rejects.toMatchObject(forbidden);
    });

    it.each([
        ["updateUserRole", () => as(memberId).mutation(updateUserRole as never, { role: "admin", userId: memberId } as never)],
        ["grantAdminByEmail", () => as(memberId).mutation(grantAdminByEmail as never, { email: "member@example.com" } as never)],
        ["revokeAdminByEmail", () => as(memberId).mutation(revokeAdminByEmail as never, { email: "admin@example.com" } as never)],
        ["banUser", () => as(memberId).mutation(banUser as never, { userId: adminId } as never)],
        ["unbanUser", () => as(memberId).mutation(unbanUser as never, { userId: adminId } as never)],
        ["revokeAllUserSessions", () => as(memberId).mutation(revokeAllUserSessions as never, { userId: adminId } as never)],
    ])("refuses a non-admin on the mutation %s", async (_name, call) => {
        await expect(call()).rejects.toMatchObject(forbidden);
    });

    it("does not let a refused self-promotion change the row", async () => {
        await expect(as(memberId).mutation(grantAdminByEmail as never, { email: "member@example.com" } as never)).rejects.toMatchObject(forbidden);

        const row = await readUser(memberId);

        expect(row.role).toBeUndefined();
        expect(await auditActions()).toEqual([]);
    });

    it("lets an admin read a user", async () => {
        await expect(as(adminId).query(checkUserAdminStatus as never, { userId: otherAdminId } as never)).resolves.toMatchObject({
            email: "other-admin@example.com",
            isAdmin: true,
        });
    });

    it("answers isCurrentUserAdmin for any signed-in caller, without an admin gate", async () => {
        await expect(as(memberId).query(isCurrentUserAdmin as never, {} as never)).resolves.toEqual({ isAdmin: false });
        await expect(as(adminId).query(isCurrentUserAdmin as never, {} as never)).resolves.toEqual({ isAdmin: true });
    });
});

describe("role changes", () => {
    it("lets an admin promote a user and writes an audit entry", async () => {
        await expect(as(adminId).mutation(updateUserRole as never, { role: "admin", userId: memberId } as never)).resolves.toBe(true);

        const row = await readUser(memberId);

        expect(row.role).toBe("admin");
        expect(await auditActions()).toEqual(["user.role.update"]);
    });

    it("lets an admin demote another admin", async () => {
        await as(adminId).mutation(updateUserRole as never, { role: "user", userId: otherAdminId } as never);

        const row = await readUser(otherAdminId);

        expect(row.role).toBeNull();
    });

    it("refuses to demote oneself", async () => {
        await expect(as(adminId).mutation(updateUserRole as never, { role: "user", userId: adminId } as never)).rejects.toMatchObject(forbidden);

        const row = await readUser(adminId);

        expect(row.role).toBe("admin");
    });

    it("grants admin by email, and reports an unknown address without failing", async () => {
        await expect(as(adminId).mutation(grantAdminByEmail as never, { email: "member@example.com" } as never)).resolves.toEqual({
            success: true,
            userId: memberId,
        });
        const row = await readUser(memberId);

        expect(row.role).toBe("admin");

        await expect(as(adminId).mutation(grantAdminByEmail as never, { email: "nobody@example.com" } as never)).resolves.toEqual({ success: false });
    });

    it("revokes admin by email but never from oneself", async () => {
        await expect(as(adminId).mutation(revokeAdminByEmail as never, { email: "admin@example.com" } as never)).rejects.toMatchObject(forbidden);
        const adminRow = await readUser(adminId);

        expect(adminRow.role).toBe("admin");

        await expect(as(adminId).mutation(revokeAdminByEmail as never, { email: "other-admin@example.com" } as never)).resolves.toMatchObject({
            success: true,
        });
        const otherAdminRow = await readUser(otherAdminId);

        expect(otherAdminRow.role).toBeNull();
    });
});

describe("bans and sessions", () => {
    it("bans a regular user, then unbans them", async () => {
        await expect(as(adminId).mutation(banUser as never, { banReason: "spam", userId: memberId } as never)).resolves.toBe(true);
        expect(await readUser(memberId)).toMatchObject({ banned: true, banReason: "spam" });

        await expect(as(adminId).mutation(unbanUser as never, { userId: memberId } as never)).resolves.toBe(true);
        expect(await readUser(memberId)).toMatchObject({ banned: false, banReason: null });
        expect(await auditActions()).toEqual(["user.ban", "user.unban"]);
    });

    it("refuses to ban oneself or another admin", async () => {
        await expect(as(adminId).mutation(banUser as never, { userId: adminId } as never)).rejects.toMatchObject(forbidden);
        await expect(as(adminId).mutation(banUser as never, { userId: otherAdminId } as never)).rejects.toMatchObject(forbidden);

        const row = await readUser(otherAdminId);

        expect(row.banned).toBeUndefined();
    });

    it("revokes every session of another user, never the caller's own", async () => {
        await seed(async (db) => {
            for (const token of ["t1", "t2"]) {
                await db.insert("session", { createdAt: 1, expiresAt: 9_999_999_999_999, token, updatedAt: 1, userId: memberId });
            }
        });

        await expect(as(adminId).mutation(revokeAllUserSessions as never, { userId: adminId } as never)).rejects.toMatchObject(forbidden);
        await expect(as(adminId).mutation(revokeAllUserSessions as never, { userId: memberId } as never)).resolves.toEqual({ revokedCount: 2 });
    });
});
