/**
 * Team procedures: who may manage a team, and that a team of another
 * organization is never reachable from the caller's active one.
 *
 * Runs on the in-memory harness. `user` is read through the better-auth helper
 * (mocked, like the session), and the organization role of each caller comes
 * from the `SESSIONS` map below.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";

const OWNER = "user-owner";
const ADMIN = "user-admin";
const MEMBER = "user-member";
const TEAM_ADMIN = "user-team-admin";
const OUTSIDER = "user-outsider";
const ORG = "org-1";
const OTHER_ORG = "org-2";

const { sessionFrom, sessions, users } = vi.hoisted(() => {
    const sessionByUser = new Map<string, { id: string; role: string } | null>();

    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) => {
            const { userId } = context.auth;

            return userId
                ? { activeOrganization: sessionByUser.get(userId) ?? null, email: `${userId}@example.com`, id: userId, isAdmin: false, name: userId, userId }
                : null;
        },
        sessions: sessionByUser,
        users: new Set<string>(),
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

vi.mock("./lib/better-auth-queries", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("./lib/better-auth-queries")>()),
        getUser: async (_context: unknown, userId: string) =>
            users.has(userId) ? { _id: userId, email: `${userId}@example.com`, image: null, name: userId } : null,
    };
});

const {
    addTeamMember,
    createTeam,
    deleteTeam,
    getMyTeams,
    getTeam,
    getTeamSettings,
    leaveTeam,
    listTeamMembers,
    removeTeamMember,
    setActiveTeam,
    updateTeam,
    updateTeamMemberRole,
    updateTeamSettings,
} = await import("./team");

let harness: ReturnType<typeof lunoraTest>;

const as = (userId: string) => harness.withIdentity({ userId } as never);

/** Inserts through the harness; the tables are `.global()` in production but plain shard tables here. */
const seed = async <T>(run: (db: any) => Promise<T>): Promise<T> => (await harness.run(async (ctx: any) => await run(ctx.db))) as T;

const insertTeam = async (organizationId = ORG, memberCount = 0): Promise<string> =>
    await seed(async (db) => await db.insert("team", { createdAt: 1, memberCount, name: "Team", organizationId }));

const insertOrgMember = async (userId: string, organizationId = ORG, role = "member"): Promise<void> => {
    await seed(async (db) => await db.insert("member", { createdAt: 1, organizationId, role, userId }));
};

const insertTeamMember = async (teamId: string, userId: string, role?: "admin" | "member"): Promise<void> => {
    await seed(async (db) => await db.insert("teamMember", { createdAt: 1, teamId, userId, ...(role && { role }) }));
};

const teamMembers = async (teamId: string): Promise<{ role?: string; userId: string }[]> =>
    await seed(async (db) => {
        const { page } = await db.teamMember.findMany({ where: { teamId } });

        return page;
    });

const teamNameOf = async (teamId: string): Promise<string | undefined> =>
    await seed(async (db) => {
        const team = await db.team.findFirst({ where: { _id: teamId } });

        return team.name;
    });

const memberCountOf = async (teamId: string): Promise<number | undefined> =>
    await seed(async (db) => {
        const team = await db.team.findFirst({ where: { _id: teamId } });

        return team.memberCount;
    });

beforeEach(() => {
    harness = lunoraTest(schema as never);
    sessions.clear();
    users.clear();
    sessions.set(OWNER, { id: ORG, role: "owner" });
    sessions.set(ADMIN, { id: ORG, role: "admin" });
    sessions.set(MEMBER, { id: ORG, role: "member" });
    sessions.set(TEAM_ADMIN, { id: ORG, role: "member" });
    sessions.set(OUTSIDER, { id: OTHER_ORG, role: "owner" });

    for (const userId of [OWNER, ADMIN, MEMBER, TEAM_ADMIN, OUTSIDER]) {
        users.add(userId);
    }
});

afterEach(() => {
    harness.close();
});

describe("createTeam", () => {
    it.each([OWNER, ADMIN])("lets organization %s create a team in the active organization", async (userId) => {
        const teamId = await as(userId).mutation(createTeam as never, { name: "Core" } as never);

        const team = await seed(async (db) => await db.team.findFirst({ where: { _id: teamId } }));

        expect(team).toMatchObject({ memberCount: 0, name: "Core", organizationId: ORG });
    });

    it("refuses a plain member", async () => {
        await expect(as(MEMBER).mutation(createTeam as never, { name: "Core" } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("refuses a caller with no active organization", async () => {
        sessions.set(MEMBER, null);

        await expect(as(MEMBER).mutation(createTeam as never, { name: "Core" } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("stops at ten teams per organization", async () => {
        for (let index = 0; index < 10; index += 1) {
            await insertTeam();
        }

        await expect(as(OWNER).mutation(createTeam as never, { name: "Eleventh" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("counts only the caller's organization toward the limit", async () => {
        for (let index = 0; index < 10; index += 1) {
            await insertTeam(OTHER_ORG);
        }

        await expect(as(OWNER).mutation(createTeam as never, { name: "First" } as never)).resolves.toBeTypeOf("string");
    });
});

describe("updateTeam and deleteTeam", () => {
    it("lets an admin rename a team", async () => {
        const teamId = await insertTeam();

        await as(ADMIN).mutation(updateTeam as never, { name: "Renamed", teamId } as never);

        expect(await teamNameOf(teamId)).toBe("Renamed");
    });

    it("refuses a plain member, even one who is a team admin", async () => {
        const teamId = await insertTeam();

        await insertTeamMember(teamId, TEAM_ADMIN, "admin");

        await expect(as(TEAM_ADMIN).mutation(updateTeam as never, { name: "Renamed", teamId } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(as(TEAM_ADMIN).mutation(deleteTeam as never, { teamId } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("refuses a team of another organization", async () => {
        const teamId = await insertTeam(OTHER_ORG);

        await expect(as(OWNER).mutation(updateTeam as never, { name: "Renamed", teamId } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(as(OWNER).mutation(deleteTeam as never, { teamId } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(await teamNameOf(teamId)).toBe("Team");
    });

    it("deletes a team with all of its members", async () => {
        const teamId = await insertTeam();

        await insertTeamMember(teamId, MEMBER);
        await insertTeamMember(teamId, TEAM_ADMIN, "admin");

        await as(OWNER).mutation(deleteTeam as never, { teamId } as never);

        expect(await teamMembers(teamId)).toStrictEqual([]);
        expect(await seed(async (db) => await db.team.findFirst({ where: { _id: teamId } }))).toBeNull();
    });
});

describe("addTeamMember", () => {
    it.each([OWNER, ADMIN])("lets organization %s add an organization member", async (userId) => {
        const teamId = await insertTeam();

        await insertOrgMember(MEMBER);
        await as(userId).mutation(addTeamMember as never, { teamId, userId: MEMBER } as never);

        expect(await teamMembers(teamId)).toMatchObject([{ role: "member", userId: MEMBER }]);
        expect(await memberCountOf(teamId)).toBe(1);
    });

    it("lets a team admin add one, though their organization role is member", async () => {
        const teamId = await insertTeam();

        await insertOrgMember(MEMBER);
        await insertTeamMember(teamId, TEAM_ADMIN, "admin");
        await as(TEAM_ADMIN).mutation(addTeamMember as never, { teamId, userId: MEMBER } as never);

        expect(await teamMembers(teamId)).toHaveLength(2);
        expect(await memberCountOf(teamId)).toBe(2);
    });

    it("refuses a plain member, and a plain team member", async () => {
        const teamId = await insertTeam();

        await insertOrgMember(OUTSIDER);
        await insertTeamMember(teamId, MEMBER, "member");

        await expect(as(MEMBER).mutation(addTeamMember as never, { teamId, userId: OUTSIDER } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(await teamMembers(teamId)).toHaveLength(1);
    });

    it("refuses a team of another organization, whatever the caller's role", async () => {
        const teamId = await insertTeam(OTHER_ORG);

        await insertOrgMember(MEMBER);

        await expect(as(OWNER).mutation(addTeamMember as never, { teamId, userId: MEMBER } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(await teamMembers(teamId)).toStrictEqual([]);
    });

    it("refuses a user who is not in the organization", async () => {
        const teamId = await insertTeam();

        await insertOrgMember(OUTSIDER, OTHER_ORG);

        await expect(as(OWNER).mutation(addTeamMember as never, { teamId, userId: OUTSIDER } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(await teamMembers(teamId)).toStrictEqual([]);
    });

    it("answers NOT_FOUND for an unknown team or user", async () => {
        const teamId = await insertTeam();

        await expect(as(OWNER).mutation(addTeamMember as never, { teamId, userId: "user-nobody" } as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("refuses to add the same user twice", async () => {
        const teamId = await insertTeam();

        await insertOrgMember(MEMBER);
        await as(OWNER).mutation(addTeamMember as never, { teamId, userId: MEMBER } as never);

        await expect(as(OWNER).mutation(addTeamMember as never, { teamId, userId: MEMBER } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(await memberCountOf(teamId)).toBe(1);
    });
});

describe("removeTeamMember", () => {
    it("lets an admin remove a member and keeps the counter true", async () => {
        const teamId = await insertTeam();

        await insertTeamMember(teamId, MEMBER);
        await insertTeamMember(teamId, TEAM_ADMIN, "admin");
        await as(ADMIN).mutation(removeTeamMember as never, { teamId, userId: MEMBER } as never);

        expect(await teamMembers(teamId)).toMatchObject([{ userId: TEAM_ADMIN }]);
        expect(await memberCountOf(teamId)).toBe(1);
    });

    it("lets a team admin whose organization role is member remove a member", async () => {
        const teamId = await insertTeam();

        await insertTeamMember(teamId, MEMBER);
        await insertTeamMember(teamId, TEAM_ADMIN, "admin");
        await as(TEAM_ADMIN).mutation(removeTeamMember as never, { teamId, userId: MEMBER } as never);

        expect(await teamMembers(teamId)).toMatchObject([{ userId: TEAM_ADMIN }]);
        expect(await memberCountOf(teamId)).toBe(1);
    });

    it("refuses a plain member", async () => {
        const teamId = await insertTeam();

        await insertTeamMember(teamId, MEMBER);
        await insertTeamMember(teamId, TEAM_ADMIN, "admin");

        await expect(as(MEMBER).mutation(removeTeamMember as never, { teamId, userId: TEAM_ADMIN } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(await teamMembers(teamId)).toHaveLength(2);
    });

    it("refuses a team of another organization", async () => {
        const teamId = await insertTeam(OTHER_ORG);

        await insertTeamMember(teamId, MEMBER);

        await expect(as(OWNER).mutation(removeTeamMember as never, { teamId, userId: MEMBER } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(await teamMembers(teamId)).toHaveLength(1);
    });
});

describe("updateTeamMemberRole", () => {
    it("lets an admin promote a member", async () => {
        const teamId = await insertTeam();

        await insertTeamMember(teamId, MEMBER);
        await as(ADMIN).mutation(updateTeamMemberRole as never, { role: "admin", teamId, userId: MEMBER } as never);

        expect(await teamMembers(teamId)).toMatchObject([{ role: "admin", userId: MEMBER }]);
    });

    it("lets a team admin whose organization role is member change a member's role", async () => {
        const teamId = await insertTeam();

        await insertTeamMember(teamId, MEMBER, "member");
        await insertTeamMember(teamId, TEAM_ADMIN, "admin");
        await as(TEAM_ADMIN).mutation(updateTeamMemberRole as never, { role: "admin", teamId, userId: MEMBER } as never);

        const members = await teamMembers(teamId);

        expect(members.find((member) => member.userId === MEMBER)).toMatchObject({ role: "admin" });
    });

    it("refuses a plain member promoting themselves", async () => {
        const teamId = await insertTeam();

        await insertTeamMember(teamId, MEMBER);

        await expect(as(MEMBER).mutation(updateTeamMemberRole as never, { role: "admin", teamId, userId: MEMBER } as never)).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
        expect(await teamMembers(teamId)).toMatchObject([{ userId: MEMBER }]);
        const [member] = await teamMembers(teamId);

        expect(member?.role).not.toBe("admin");
    });
});

describe("updateTeamMemberRole across organizations", () => {
    it("refuses a team of another organization and leaves the member's role alone", async () => {
        const teamId = await insertTeam(OTHER_ORG);

        await insertTeamMember(teamId, MEMBER, "member");

        await expect(as(OWNER).mutation(updateTeamMemberRole as never, { role: "admin", teamId, userId: MEMBER } as never)).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
        expect(await teamMembers(teamId)).toMatchObject([{ role: "member", userId: MEMBER }]);
    });
});

describe("updateTeamSettings", () => {
    const settingsOf = async (teamId: string) => await seed(async (db) => await db.teamSettings.findFirst({ where: { teamId } }));
    const allowedModelsOf = async (teamId: string) => {
        const settings = await settingsOf(teamId);

        return settings?.allowedModels;
    };

    it("lets an admin set the allowed models, and clearing them removes the override", async () => {
        const teamId = await insertTeam();

        await as(ADMIN).mutation(updateTeamSettings as never, { allowedModels: ["m1"], teamId } as never);
        expect(await settingsOf(teamId)).toMatchObject({ allowedModels: ["m1"], organizationId: ORG });

        await as(ADMIN).mutation(updateTeamSettings as never, { allowedModels: null, teamId } as never);
        expect(await allowedModelsOf(teamId)).toBeUndefined();
    });

    it("lets a team admin edit, and refuses a plain team member", async () => {
        const teamId = await insertTeam();

        await insertTeamMember(teamId, TEAM_ADMIN, "admin");
        await insertTeamMember(teamId, MEMBER, "member");

        await as(TEAM_ADMIN).mutation(updateTeamSettings as never, { allowedModels: ["m1"], teamId } as never);

        await expect(as(MEMBER).mutation(updateTeamSettings as never, { allowedModels: ["m2"], teamId } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(await allowedModelsOf(teamId)).toStrictEqual(["m1"]);
    });

    it("refuses a team of another organization", async () => {
        const teamId = await insertTeam(OTHER_ORG);

        await expect(as(OWNER).mutation(updateTeamSettings as never, { allowedModels: ["m1"], teamId } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(await settingsOf(teamId)).toBeNull();
    });
});

describe("setActiveTeam and leaveTeam", () => {
    it("refuses to activate a team the caller is not on", async () => {
        const teamId = await insertTeam();

        await expect(as(MEMBER).mutation(setActiveTeam as never, { teamId } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("refuses to activate a team of another organization, even for a member of it", async () => {
        const teamId = await insertTeam(OTHER_ORG);

        await insertTeamMember(teamId, MEMBER);

        await expect(as(MEMBER).mutation(setActiveTeam as never, { teamId } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("stores the active team on the caller's session and clears it again", async () => {
        const teamId = await insertTeam();

        await insertTeamMember(teamId, MEMBER);
        await seed(
            async (db) => await db.insert("session", { createdAt: 1, expiresAt: Number.MAX_SAFE_INTEGER, token: "token-member", updatedAt: 1, userId: MEMBER }),
        );

        const activeTeamId = async (): Promise<string | undefined> =>
            await seed(async (db) => {
                const session = await db.session.findFirst({ where: { userId: MEMBER } });

                return session.activeTeamId;
            });

        await as(MEMBER).mutation(setActiveTeam as never, { teamId } as never);
        expect(await activeTeamId()).toBe(teamId);

        await as(MEMBER).mutation(setActiveTeam as never, { teamId: null } as never);
        expect(await activeTeamId()).toBeUndefined();
    });

    it("lets a member leave, and keeps the counter true", async () => {
        const teamId = await insertTeam();

        await insertTeamMember(teamId, MEMBER);
        await insertTeamMember(teamId, TEAM_ADMIN, "admin");
        await as(MEMBER).mutation(leaveTeam as never, { teamId } as never);

        expect(await teamMembers(teamId)).toMatchObject([{ userId: TEAM_ADMIN }]);
        expect(await memberCountOf(teamId)).toBe(1);
    });

    it("refuses to leave a team of another organization and keeps the membership and counter", async () => {
        const teamId = await insertTeam(OTHER_ORG, 2);

        await insertTeamMember(teamId, MEMBER);
        await insertTeamMember(teamId, TEAM_ADMIN, "admin");

        await expect(as(MEMBER).mutation(leaveTeam as never, { teamId } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(await teamMembers(teamId)).toHaveLength(2);
        expect(await memberCountOf(teamId)).toBe(2);
    });

    it("answers NOT_FOUND when the caller was never on the team", async () => {
        const teamId = await insertTeam();

        await expect(as(MEMBER).mutation(leaveTeam as never, { teamId } as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
});

describe("reads", () => {
    it("hides a team of another organization", async () => {
        const teamId = await insertTeam(OTHER_ORG);

        await insertTeamMember(teamId, MEMBER);

        await expect(as(OWNER).query(getTeam as never, { teamId } as never)).resolves.toBeNull();
        await expect(as(OWNER).query(listTeamMembers as never, { teamId } as never)).resolves.toStrictEqual([]);
    });

    it("hides the settings of a team of another organization, even from a member of that team", async () => {
        const teamId = await insertTeam(OTHER_ORG);

        await insertTeamMember(teamId, MEMBER, "admin");
        await seed(async (db) => await db.insert("teamSettings", { allowedModels: ["secret"], organizationId: OTHER_ORG, teamId }));

        await expect(as(OWNER).query(getTeamSettings as never, { teamId } as never)).resolves.toBeNull();
        await expect(as(MEMBER).query(getTeamSettings as never, { teamId } as never)).resolves.toBeNull();
    });

    it("returns the settings of a team in the active organization to an admin", async () => {
        const teamId = await insertTeam();

        await seed(async (db) => await db.insert("teamSettings", { allowedModels: ["m1"], organizationId: ORG, teamId }));

        await expect(as(ADMIN).query(getTeamSettings as never, { teamId } as never)).resolves.toMatchObject({ allowedModels: ["m1"], teamId });
    });

    it("lists only the caller's teams of the active organization", async () => {
        const own = await insertTeam();
        const foreign = await insertTeam(OTHER_ORG);

        await insertTeamMember(own, MEMBER, "admin");
        await insertTeamMember(foreign, MEMBER);

        const teams = (await as(MEMBER).query(getMyTeams as never, {} as never)) as { id: string; role: string }[];

        expect(teams).toMatchObject([{ id: own, role: "admin" }]);
    });

    it("lists the members of a team in the active organization", async () => {
        const teamId = await insertTeam();

        await insertTeamMember(teamId, MEMBER);

        const members = (await as(OWNER).query(listTeamMembers as never, { teamId } as never)) as { role: string; userId: string }[];

        expect(members).toMatchObject([{ role: "member", userId: MEMBER }]);
    });
});
