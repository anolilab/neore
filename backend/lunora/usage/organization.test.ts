/**
 * The organization view: a reply is filed under its organization and project at
 * record time, a member's read adds up exactly those rows, and the action hands
 * the client organization-wide totals only — never a sum it could narrow to one
 * member.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => {
    const { registeredApi } = await import("../../test/registered-api");

    return registeredApi(await importOriginal(), registry);
});
vi.mock("../_generated/internal", async (importOriginal) => {
    const { registeredApi } = await import("../../test/registered-api");

    return registeredApi(await importOriginal(), registry);
});

const { harnessRef, sessionFrom } = vi.hoisted(() => {
    vi.stubEnv("ENCRYPTION_KEY", btoa(String.fromCodePoint(...Array.from({ length: 32 }, (_, index) => index + 1))));

    return {
        harnessRef: { current: undefined as any },
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId
                ? { activeOrganization: { id: "org_1", role: "admin" }, id: context.auth.userId, isAdmin: false, userId: context.auth.userId }
                : null,
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

// One database serves every shard in the harness: a member's shard call runs right here.
vi.mock("../lib/cross-shard", () => {
    return {
        callOnShard: async (_reference: unknown, args: Record<string, unknown>) => {
            const { memberOrganizationUsage } = await import("./organization");

            return await harnessRef.current.run(async (ctx: any) => await ctx.runQuery(memberOrganizationUsage, args));
        },
    };
});

const { registerModule } = await import("../../test/registered-api");
const { default: schema } = await import("../schema");
const { recordReplyUsage } = await import("./activity");
const { DEFAULT_SKILL_KEY } = await import("./activity-logic");
const {
    getOrganizationProjectUsage,
    isOrganizationAdminRole,
    MAX_CURSOR_PROJECTS,
    memberOrganizationUsage,
    MEMBERS_PER_CALL,
    openCursor,
    organizationUsageScope,
} = await import("./organization");

const ADMIN = "user-admin";
const MEMBER = "user-member";
const ORG = "org_1";
const FROM = "2026-09-01";

let harness: ReturnType<typeof lunoraTest>;
let replies = 0;

const insert = async (table: string, row: Record<string, unknown>): Promise<string> => await harness.run(async (ctx: any) => await ctx.db.insert(table, row));

const record = async (userId: string, threadId: string, costMicrodollars: number) => {
    replies += 1;

    await harness.run(
        async (ctx: any) =>
            await ctx.runMutation(recordReplyUsage, {
                at: 1,
                costMicrodollars,
                date: "2026-09-20",
                replyKey: `reply-${String(replies)}`,
                skillKey: DEFAULT_SKILL_KEY,
                threadId,
                tokens: 1,
                userId,
            }),
    );
};

/** For `userId`: a thread in the org's project, one in the org with no project, and one of their own. */
const usageOf = async (userId: string, projectId: string, inProject: number, inOrganization: number, own: number) => {
    await record(userId, await insert("threads", { organizationId: ORG, projectId, status: "active", title: "T", userId }), inProject);
    await record(userId, await insert("threads", { organizationId: ORG, status: "active", title: "T", userId }), inOrganization);
    await record(userId, await insert("threads", { status: "active", title: "T", userId }), own);
};

const asAdmin = () => harness.withIdentity({ userId: ADMIN } as never);

const read = async (cursor?: string) =>
    (await asAdmin().action(getOrganizationProjectUsage as never, { fromDate: FROM, ...(cursor !== undefined && { cursor }) } as never)) as {
        cursor?: string;
        result?: any;
    };

registerModule(registry, "usage_organization", await import("./organization"));

beforeEach(() => {
    harness = lunoraTest(schema as never);
    harnessRef.current = harness;
});

afterEach(() => {
    harness.close();
});

describe("organization usage", () => {
    it("adds every member's usage in the organization up, per project, with No project the rest", async () => {
        const project = await insert("projects", { createdAt: 0, organizationId: ORG, title: "Org project", userId: ADMIN });

        await insert("member", { createdAt: 0, organizationId: ORG, role: "owner,member", userId: ADMIN });
        await insert("member", { createdAt: 0, organizationId: ORG, role: "member", userId: MEMBER });
        await usageOf(ADMIN, project, 100, 10, 1000);
        await usageOf(MEMBER, project, 200, 20, 2000);

        const { result } = await read();

        expect(result.total.costMicrodollars).toBe(330);
        expect(result.projects).toMatchObject([{ costMicrodollars: 300, projectKey: project, title: "Org project" }]);
        expect(result.noProject.costMicrodollars).toBe(30);
        expect(result.members).toBe(2);
    });

    it("shows an admin only their own organization's usage, never another's", async () => {
        const ours = await insert("projects", { createdAt: 0, organizationId: ORG, title: "Ours", userId: ADMIN });
        const theirs = await insert("projects", { createdAt: 0, organizationId: "org_2", title: "Theirs", userId: MEMBER });

        await insert("member", { createdAt: 0, organizationId: ORG, role: "admin", userId: ADMIN });
        // MEMBER belongs to both organizations and works in each.
        await insert("member", { createdAt: 0, organizationId: ORG, role: "member", userId: MEMBER });
        await insert("member", { createdAt: 0, organizationId: "org_2", role: "admin", userId: MEMBER });
        await record(MEMBER, await insert("threads", { organizationId: ORG, projectId: ours, status: "active", title: "T", userId: MEMBER }), 100);
        await record(MEMBER, await insert("threads", { organizationId: "org_2", projectId: theirs, status: "active", title: "T", userId: MEMBER }), 900);
        await record(MEMBER, await insert("threads", { organizationId: "org_2", status: "active", title: "T", userId: MEMBER }), 90);

        const { result } = await read();

        expect(result.total.costMicrodollars).toBe(100);
        expect(result.projects.map((project: { title: string }) => project.title)).toStrictEqual(["Ours"]);
        expect(JSON.stringify(result)).not.toContain(theirs);
    });

    it("counts a member's own project in an organization thread under No project, without its name or id", async () => {
        const personal = await insert("projects", { createdAt: 0, title: "My diary", userId: MEMBER });

        await insert("member", { createdAt: 0, organizationId: ORG, role: "admin", userId: ADMIN });
        await insert("member", { createdAt: 0, organizationId: ORG, role: "member", userId: MEMBER });
        await record(MEMBER, await insert("threads", { organizationId: ORG, projectId: personal, status: "active", title: "T", userId: MEMBER }), 50);

        const { result } = await read();

        expect(result.total.costMicrodollars).toBe(50);
        expect(result.noProject.costMicrodollars).toBe(50);
        expect(result.projects).toStrictEqual([]);
        expect(JSON.stringify(result)).not.toContain(personal);
        expect(JSON.stringify(result)).not.toContain("My diary");
    });

    it("moves a project that left the organization into No project, and names projects past the first page", async () => {
        const moved = await insert("projects", { createdAt: 0, organizationId: ORG, title: "Moved", userId: ADMIN });

        await insert("member", { createdAt: 0, organizationId: ORG, role: "admin", userId: ADMIN });
        await usageOf(ADMIN, moved, 100, 0, 0);
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("projects", moved, { organizationId: "org_other" });
        });

        const { result } = await read();

        expect(result.total.costMicrodollars).toBe(100);
        expect(result.projects).toStrictEqual([]);
        expect(result.noProject.costMicrodollars).toBe(100);
    });

    it("never hands the client a partial sum, and refuses a cursor it did not issue to this caller", async () => {
        const project = await insert("projects", { createdAt: 0, organizationId: ORG, title: "P", userId: ADMIN });

        await insert("member", { createdAt: 0, organizationId: ORG, role: "admin", userId: ADMIN });

        for (let index = 0; index < MEMBERS_PER_CALL; index += 1) {
            const userId = `user-${String(index).padStart(3, "0")}`;

            await insert("member", { createdAt: 0, organizationId: ORG, role: "member", userId });
            await usageOf(userId, project, 1, 0, 0);
        }

        const first = await read();

        expect(Object.keys(first)).toStrictEqual(["cursor"]);
        await expect(openCursor(first.cursor!, { fromDate: FROM, now: Date.now(), organizationId: ORG, requesterId: MEMBER })).rejects.toMatchObject({
            code: "BAD_REQUEST",
        });
        await expect(read("v1:forged")).rejects.toMatchObject({ code: "BAD_REQUEST" });

        const last = await read(first.cursor);

        expect(last.result.total.costMicrodollars).toBe(MEMBERS_PER_CALL);
        expect(last.cursor).toBeUndefined();
    });

    it("keeps the cursor bounded when members use more projects than it carries, and says the result was cut", async () => {
        await insert("member", { createdAt: 0, organizationId: ORG, role: "admin", userId: ADMIN });

        // One more project than a cursor carries, filed under the organization, on a member past the first page.
        for (let index = 0; index < MEMBERS_PER_CALL; index += 1) {
            await insert("member", { createdAt: 0, organizationId: ORG, role: "member", userId: `user-${String(index).padStart(3, "0")}` });
        }

        await harness.run(async (ctx: any) => {
            for (let index = 0; index <= MAX_CURSOR_PROJECTS; index += 1) {
                await ctx.db.insert("usageDaily", {
                    costMicrodollars: index + 1,
                    date: "2026-09-20",
                    organizationId: ORG,
                    projectKey: `project-${String(index)}`,
                    replies: 1,
                    skillKey: "__project__",
                    tokens: 1,
                    updatedAt: 1,
                    userId: ADMIN,
                });
            }
        });

        const first = await read();
        const last = await read(first.cursor);

        expect(first.cursor!.length).toBeLessThan(200_000);
        expect(last.result.truncated).toBe(true);
    });

    it("refuses a caller who is not an admin or owner of the organization", async () => {
        await insert("member", { createdAt: 0, organizationId: ORG, role: "member", userId: ADMIN });

        await expect(read()).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(await harness.run(async (ctx: any) => await ctx.runQuery(organizationUsageScope, { organizationId: ORG, userId: ADMIN }))).toBeNull();
    });

    it("reads a member who has not been active since, from the rows their replies recorded", async () => {
        await record(MEMBER, await insert("threads", { organizationId: ORG, status: "active", title: "T", userId: MEMBER }), 30);

        const result = await harness.run(
            async (ctx: any) => await ctx.runQuery(memberOrganizationUsage, { fromDate: FROM, organizationId: ORG, userId: MEMBER }),
        );
        const other = await harness.run(
            async (ctx: any) => await ctx.runQuery(memberOrganizationUsage, { fromDate: FROM, organizationId: "org_2", userId: MEMBER }),
        );

        expect(result.total.costMicrodollars).toBe(30);
        expect(other.total.costMicrodollars).toBe(0);
    });
});

describe("isOrganizationAdminRole", () => {
    it("reads each of a member's comma-separated roles", () => {
        expect(isOrganizationAdminRole("admin,member")).toBe(true);
        expect(isOrganizationAdminRole("member, owner")).toBe(true);
        expect(isOrganizationAdminRole("member")).toBe(false);
    });
});
