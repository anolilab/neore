/**
 * The organization view: each reply adds to its organization's rollup when it
 * is recorded, and the view reads that rollup — every member, past and
 * present, and only projects the organization owns, totals only.
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

const { sessionFrom } = vi.hoisted(() => {
    return {
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

const { registerModule } = await import("../../test/registered-api");
const { default: schema } = await import("../schema");
const { recordReplyUsage } = await import("./activity");
const { DEFAULT_SKILL_KEY, ORGANIZATION_TOTAL_KEY } = await import("./activity-logic");
const { getOrganizationProjectUsage, isOrganizationAdminRole, MAX_PROJECTS, ORGANIZATION_ROW_PAGE, pruneOrganizationUsage } = await import("./organization");
const { eraseOrganizationUsage } = await import("./organization-erase");
const { collectOrganizationUsageForExport, collectUsageDailyPages, eraseUsageForUser } = await import("./gdpr");

registerModule(registry, "usage_organization", await import("./organization"));

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

/** For `userId`: a reply in the org's project, one in the org with no project, and one of their own. */
const usageOf = async (userId: string, projectId: string, inProject: number, inOrganization: number, own: number) => {
    await record(userId, await insert("threads", { organizationId: ORG, projectId, status: "active", title: "T", userId }), inProject);
    await record(userId, await insert("threads", { organizationId: ORG, status: "active", title: "T", userId }), inOrganization);
    await record(userId, await insert("threads", { status: "active", title: "T", userId }), own);
};

const read = async (args: Record<string, unknown> = {}) =>
    (await harness.withIdentity({ userId: ADMIN } as never).action(getOrganizationProjectUsage as never, { fromDate: FROM, ...args } as never)) as {
        result: {
            noProject: { costMicrodollars: number };
            projects: { costMicrodollars: number; projectKey: string; title: string }[];
            projectsCut: boolean;
            total: { costMicrodollars: number; replies: number };
            truncated: boolean;
        };
    };

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    await insert("member", { createdAt: 0, organizationId: ORG, role: "owner,member", userId: ADMIN });
});

afterEach(() => {
    harness.close();
});

describe("organization usage", () => {
    it("adds every member's usage in the organization up, per project, with No project the rest", async () => {
        const project = await insert("projects", { createdAt: 0, organizationId: ORG, title: "Org project", userId: ADMIN });

        await insert("member", { createdAt: 0, organizationId: ORG, role: "member", userId: MEMBER });
        await usageOf(ADMIN, project, 100, 10, 1000);
        await usageOf(MEMBER, project, 200, 20, 2000);

        const { result } = await read();

        expect(result.total.costMicrodollars).toBe(330);
        expect(result.projects).toMatchObject([{ costMicrodollars: 300, projectKey: project, title: "Org project" }]);
        expect(result.noProject.costMicrodollars).toBe(30);
    });

    it("keeps a member's spend in the organization's totals after they leave", async () => {
        const project = await insert("projects", { createdAt: 0, organizationId: ORG, title: "Org project", userId: ADMIN });
        const membership = await insert("member", { createdAt: 0, organizationId: ORG, role: "member", userId: MEMBER });

        await usageOf(MEMBER, project, 200, 20, 2000);

        const before = await read();

        await harness.run(async (ctx: any) => {
            await ctx.db.delete("member", membership);
        });

        const after = await read();

        expect(after.result.total).toStrictEqual(before.result.total);
        expect(after.result.projects).toStrictEqual(before.result.projects);
        expect(after.result.total.costMicrodollars).toBe(220);
    });

    it("shows an admin only their own organization's usage, never another's", async () => {
        const ours = await insert("projects", { createdAt: 0, organizationId: ORG, title: "Ours", userId: ADMIN });
        const theirs = await insert("projects", { createdAt: 0, organizationId: "org_2", title: "Theirs", userId: MEMBER });

        await record(MEMBER, await insert("threads", { organizationId: ORG, projectId: ours, status: "active", title: "T", userId: MEMBER }), 100);
        await record(MEMBER, await insert("threads", { organizationId: "org_2", projectId: theirs, status: "active", title: "T", userId: MEMBER }), 900);
        await record(MEMBER, await insert("threads", { organizationId: "org_2", status: "active", title: "T", userId: MEMBER }), 90);

        const { result } = await read();

        expect(result.total.costMicrodollars).toBe(100);
        expect(result.projects.map((project) => project.title)).toStrictEqual(["Ours"]);
        expect(JSON.stringify(result)).not.toContain(theirs);
    });

    it("counts a member's own project in an organization thread under No project, without its name or id", async () => {
        const personal = await insert("projects", { createdAt: 0, title: "My diary", userId: MEMBER });

        await record(MEMBER, await insert("threads", { organizationId: ORG, projectId: personal, status: "active", title: "T", userId: MEMBER }), 50);

        const { result } = await read();

        expect(result.total.costMicrodollars).toBe(50);
        expect(result.noProject.costMicrodollars).toBe(50);
        expect(result.projects).toStrictEqual([]);
        expect(JSON.stringify(result)).not.toContain(personal);
        expect(JSON.stringify(result)).not.toContain("My diary");
    });

    it("moves a project that left the organization into No project", async () => {
        const moved = await insert("projects", { createdAt: 0, organizationId: ORG, title: "Moved", userId: ADMIN });

        await usageOf(ADMIN, moved, 100, 0, 0);
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("projects", moved, { organizationId: "org_other" });
        });

        const { result } = await read();

        expect(result.total.costMicrodollars).toBe(100);
        expect(result.projects).toStrictEqual([]);
        expect(result.noProject.costMicrodollars).toBe(100);
    });

    it("reads every page of a busy organization's rows", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index <= ORGANIZATION_ROW_PAGE; index += 1) {
                await ctx.db.insert("usageOrganizationDaily", {
                    costMicrodollars: 1,
                    date: "2026-09-20",
                    organizationId: ORG,
                    projectKey: ORGANIZATION_TOTAL_KEY,
                    replies: 1,
                    tokens: 1,
                    updatedAt: index,
                    userId: `user-${String(index)}`,
                });
            }
        });

        const { result } = await read();

        expect(result.total.replies).toBe(ORGANIZATION_ROW_PAGE + 1);
        expect(result.truncated).toBe(false);
    });

    it("refuses a page whose active organization has changed, and a caller who is not an admin or owner", async () => {
        await expect(read({ organizationId: "org_2" })).rejects.toMatchObject({ code: "CONFLICT" });
        await harness.run(async (ctx: any) => {
            const row = await ctx.db.member.findFirst({ where: { organizationId: ORG, userId: ADMIN } });

            await ctx.db.patch("member", row._id, { role: "member" });
        });
        await expect(read()).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("prunes organization rows past the usage rollup's retention", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 501; index += 1) {
                await ctx.db.insert("usageOrganizationDaily", {
                    costMicrodollars: 1,
                    date: "2000-01-01",
                    organizationId: ORG,
                    projectKey: ORGANIZATION_TOTAL_KEY,
                    replies: 1,
                    tokens: 1,
                    updatedAt: 0,
                    userId: `user-${String(index)}`,
                });
            }
        });

        // A full batch deletes 500 and schedules the next; the next takes the rest.
        expect(await harness.run(async (ctx: any) => await ctx.runMutation(pruneOrganizationUsage, {}))).toBe(500);
        expect(await harness.run(async (ctx: any) => await ctx.runMutation(pruneOrganizationUsage, {}))).toBe(1);
    });
});

describe("organization usage rows", () => {
    it("keeps each member's share of a day on its own row, written only by that member", async () => {
        await insert("member", { createdAt: 0, organizationId: ORG, role: "member", userId: MEMBER });
        await record(ADMIN, await insert("threads", { organizationId: ORG, status: "active", title: "T", userId: ADMIN }), 10);
        await record(MEMBER, await insert("threads", { organizationId: ORG, status: "active", title: "T", userId: MEMBER }), 20);
        await record(MEMBER, await insert("threads", { organizationId: ORG, status: "active", title: "T", userId: MEMBER }), 5);

        const rows = await harness.run(async (ctx: any) => {
            const { page } = await ctx.db.usageOrganizationDaily.findMany({ where: { organizationId: ORG } });

            return page.map((row: any) => [row.userId, row.costMicrodollars]).toSorted((a: string[], b: string[]) => a[0]!.localeCompare(b[0]!));
        });

        expect(rows).toStrictEqual([
            [ADMIN, 10],
            [MEMBER, 25],
        ]);
        const { result } = await read();

        expect(result.total.costMicrodollars).toBe(35);
    });

    it("erases a member's share with their account, and exports it to them, a page at a time", async () => {
        await record(MEMBER, await insert("threads", { organizationId: ORG, status: "active", title: "T", userId: MEMBER }), 20);

        const exported = await collectUsageDailyPages(
            async (cursor) =>
                (await harness.run(async (ctx: any) => await ctx.runQuery(collectOrganizationUsageForExport, { cursor, userId: MEMBER }))) as never,
        );

        expect(exported).toMatchObject([{ costMicrodollars: 20, organization: ORG }]);
        await harness.run(async (ctx: any) => await eraseUsageForUser(ctx, MEMBER));

        const { result } = await read();

        expect(result.total.costMicrodollars).toBe(0);
    });

    it("erases a deleted organization's usage", async () => {
        await record(MEMBER, await insert("threads", { organizationId: ORG, status: "active", title: "T", userId: MEMBER }), 20);

        expect(await harness.run(async (ctx: any) => await ctx.runMutation(eraseOrganizationUsage, { organizationId: ORG }))).toBe(1);

        const { result } = await read();

        expect(result.total.costMicrodollars).toBe(0);
    });

    it("says when projects with no usage are left out, without calling the period incomplete", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index <= MAX_PROJECTS; index += 1) {
                await ctx.db.insert("projects", { createdAt: 0, organizationId: ORG, title: `P${String(index)}`, userId: ADMIN });
            }
        });

        const { result } = await read();

        expect(result.projectsCut).toBe(true);
        expect(result.truncated).toBe(false);
    });
});

describe("isOrganizationAdminRole", () => {
    it("reads each of a member's comma-separated roles", () => {
        expect(isOrganizationAdminRole("admin,member")).toBe(true);
        expect(isOrganizationAdminRole("member, owner")).toBe(true);
        expect(isOrganizationAdminRole("member")).toBe(false);
    });
});
