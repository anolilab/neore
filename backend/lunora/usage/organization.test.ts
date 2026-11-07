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

vi.mock("../lib/shard-scheduler", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/shard-scheduler")>()),
        // Kept to be run after the forwarding mutation, as the target shard would.
        runAfterOnShard: async (_scheduler: unknown, _delay: number, _target: unknown, args: Record<string, unknown>) => {
            harnessRef.forwarded.push(args);

            return "scheduled";
        },
    };
});

const harnessRef = vi.hoisted(() => {
    return { forwarded: [] as Record<string, unknown>[] };
});

const { registerModule } = await import("../../test/registered-api");
const { default: schema } = await import("../schema");
const { forwardReplyUsage, recordReplyUsage } = await import("./activity");
const { DEFAULT_SKILL_KEY } = await import("./activity-logic");
const { getOrganizationProjectUsage, isOrganizationAdminRole, MAX_PROJECTS, pruneOrganizationUsage } = await import("./organization");

/** More replies than any one page of rows would hold: the read sums them in the database. */
const BUSY = 2500;
const { eraseOrganizationUsage, sweepOrphanedOrganizationUsage } = await import("./organization-erase");
const { collectOrganizationUsageForExport, collectOrganizationUsagePages, eraseUsageForUser, ORGANIZATION_EXPORT_PAGE } = await import("./gdpr");

registerModule(registry, "usage_organization", await import("./organization"));

const ADMIN = "user-admin";
const MEMBER = "user-member";
const ORG = "org_1";
const FROM = "2026-09-01";
/** When the tests' replies are recorded: inside the period from `FROM` on. */
const AT = Date.UTC(2026, 8, 20, 12);

let harness: ReturnType<typeof lunoraTest>;
let replies = 0;

const insert = async (table: string, row: Record<string, unknown>): Promise<string> => await harness.run(async (ctx: any) => await ctx.db.insert(table, row));

const record = async (userId: string, threadId: string, costMicrodollars: number) => {
    replies += 1;

    await harness.run(
        async (ctx: any) =>
            await ctx.runMutation(recordReplyUsage, {
                at: AT,
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
        };
    };

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    harnessRef.forwarded.length = 0;
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
        await insert("member", { createdAt: 0, organizationId: ORG, role: "member", userId: MEMBER });
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
        await insert("member", { createdAt: 0, organizationId: ORG, role: "member", userId: MEMBER });
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

    it("sums a busy organization's replies in one read, never cut short", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < BUSY; index += 1) {
                await ctx.db.insert("usageOrganizationReplies", {
                    costMicrodollars: 1,
                    date: "2026-09-20",
                    organizationId: ORG,
                    recordedAt: AT,
                    replyKey: `reply-${String(index)}`,
                    tokens: 1,
                    userId: `user-${String(index)}`,
                });
            }
        });

        const { result } = await read();

        expect(result.total).toStrictEqual({ costMicrodollars: BUSY, replies: BUSY, tokens: BUSY });
        expect(result.noProject).toMatchObject({ replies: BUSY });
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
                await ctx.db.insert("usageOrganizationReplies", {
                    costMicrodollars: 1,
                    date: "2000-01-01",
                    organizationId: ORG,
                    recordedAt: 0,
                    replyKey: `reply-${String(index)}`,
                    tokens: 1,
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
    it("keeps one row per reply, with the member it belongs to", async () => {
        await insert("member", { createdAt: 0, organizationId: ORG, role: "member", userId: MEMBER });
        await record(ADMIN, await insert("threads", { organizationId: ORG, status: "active", title: "T", userId: ADMIN }), 10);
        await record(MEMBER, await insert("threads", { organizationId: ORG, status: "active", title: "T", userId: MEMBER }), 20);
        await record(MEMBER, await insert("threads", { organizationId: ORG, status: "active", title: "T", userId: MEMBER }), 5);

        const rows = await harness.run(async (ctx: any) => {
            const { page } = await ctx.db.usageOrganizationReplies.findMany({ where: { organizationId: ORG } });

            return page
                .map((row: any) => [row.userId, row.costMicrodollars])
                .toSorted((a: [string, number], b: [string, number]) => a[0].localeCompare(b[0]) || a[1] - b[1]);
        });

        expect(rows).toStrictEqual([
            [ADMIN, 10],
            [MEMBER, 5],
            [MEMBER, 20],
        ]);
        const { result } = await read();

        expect(result.total.costMicrodollars).toBe(35);
    });

    it("files a re-delivered reply once", async () => {
        const thread = await insert("threads", { organizationId: ORG, status: "active", title: "T", userId: ADMIN });
        const args = {
            at: AT,
            costMicrodollars: 30,
            date: "2026-09-20",
            replyKey: "redelivered-reply",
            skillKey: DEFAULT_SKILL_KEY,
            threadId: thread,
            tokens: 1,
            userId: ADMIN,
        };

        await harness.run(async (ctx: any) => await ctx.runMutation(recordReplyUsage, args));
        await harness.run(async (ctx: any) => await ctx.runMutation(recordReplyUsage, args));

        const { result } = await read();

        expect(result.total).toMatchObject({ costMicrodollars: 30, replies: 1 });
    });

    it("files a reply once when its record is retried after the organization's row was written", async () => {
        const thread = await insert("threads", { organizationId: ORG, status: "active", title: "T", userId: ADMIN });
        const recordOnce = async () =>
            await harness.run(
                async (ctx: any) =>
                    await ctx.runMutation(recordReplyUsage, {
                        at: AT,
                        costMicrodollars: 30,
                        date: "2026-09-20",
                        replyKey: "retried-reply",
                        skillKey: DEFAULT_SKILL_KEY,
                        threadId: thread,
                        tokens: 1,
                        userId: ADMIN,
                    }),
            );

        await recordOnce();
        // The member's own writes did not hold (their shard's transaction failed after the organization's row landed).
        await harness.run(async (ctx: any) => {
            for (const table of ["usageReplies", "usageDaily"]) {
                const { page } = await ctx.db[table].findMany({ where: { userId: ADMIN } });

                for (const row of page) {
                    await ctx.db.delete(table, row._id);
                }
            }
        });
        await recordOnce();

        const { result } = await read();

        expect(result.total).toMatchObject({ costMicrodollars: 30, replies: 1 });
    });

    it("erases a member's share with their account, and exports it to them, a page at a time", async () => {
        await insert("member", { createdAt: 0, organizationId: ORG, role: "member", userId: MEMBER });
        await record(MEMBER, await insert("threads", { organizationId: ORG, status: "active", title: "T", userId: MEMBER }), 20);

        const exported = await collectOrganizationUsagePages(
            async (cursor) =>
                (await harness.run(async (ctx: any) => await ctx.runQuery(collectOrganizationUsageForExport, { cursor, userId: MEMBER }))) as never,
        );

        expect(exported).toMatchObject([{ costMicrodollars: 20, organization: ORG, replies: 1 }]);
        await harness.run(async (ctx: any) => await eraseUsageForUser(ctx, MEMBER));

        const { result } = await read();

        expect(result.total.costMicrodollars).toBe(0);
    });

    it("finishes erasing a member's usage on the retry after a delete fails part-way, and never reports done early", async () => {
        await insert("member", { createdAt: 0, organizationId: ORG, role: "member", userId: MEMBER });
        await record(MEMBER, await insert("threads", { organizationId: ORG, status: "active", title: "T", userId: MEMBER }), 20);
        await record(MEMBER, await insert("threads", { status: "active", title: "T", userId: MEMBER }), 5);

        const remaining = async () =>
            await harness.run(async (ctx: any) => {
                const counts: Record<string, number> = {};

                for (const table of ["usageDaily", "usageReplies", "usageOrganizationReplies"]) {
                    const { page } = await ctx.db[table].findMany({ where: { userId: MEMBER } });

                    counts[table] = page.length;
                }

                return counts;
            });

        expect(await remaining()).toMatchObject({ usageDaily: expect.any(Number), usageOrganizationReplies: 1 });

        // The first round fails on one of the member's own rows.
        await expect(
            harness.run(async (ctx: any) => {
                const failing = new Proxy(ctx.db, {
                    get: (target, key) =>
                        key === "delete"
                            ? async (table: string, id: string) => {
                                  if (table === "usageDaily") {
                                      throw new Error("delete failed");
                                  }

                                  return await target.delete(table, id);
                              }
                            : Reflect.get(target, key),
                });

                return await eraseUsageForUser({ ...ctx, db: failing }, MEMBER);
            }),
        ).rejects.toThrow("delete failed");

        // The step's retry takes what is left, round after round, until it says there is nothing more.
        for (let round = 0; ; round += 1) {
            const { hasMore } = await harness.run(async (ctx: any) => await eraseUsageForUser(ctx, MEMBER));

            if (!hasMore || round > 5) {
                break;
            }
        }

        expect(await remaining()).toStrictEqual({ usageDaily: 0, usageOrganizationReplies: 0, usageReplies: 0 });
    });

    it("exports a busy member's organization usage summed per day and project, across every page", async () => {
        const project = await insert("projects", { createdAt: 0, organizationId: ORG, title: "Org project", userId: ADMIN });
        const count = ORGANIZATION_EXPORT_PAGE + 5;

        await harness.run(async (ctx: any) => {
            for (let index = 0; index < count; index += 1) {
                await ctx.db.insert("usageOrganizationReplies", {
                    costMicrodollars: 2,
                    date: "2026-09-20",
                    organizationId: ORG,
                    recordedAt: 0,
                    replyKey: `busy-${String(index)}`,
                    tokens: 1,
                    userId: MEMBER,
                    ...(index % 2 === 0 && { projectKey: project }),
                });
            }
        });

        const exported = await collectOrganizationUsagePages(
            async (cursor) =>
                (await harness.run(async (ctx: any) => await ctx.runQuery(collectOrganizationUsageForExport, { cursor, userId: MEMBER }))) as never,
        );
        const inProject = Math.ceil(count / 2);

        expect(exported).toHaveLength(2);
        expect(exported.find((row) => row.project === project)).toMatchObject({ costMicrodollars: 2 * inProject, replies: inProject, tokens: inProject });
        expect(exported.find((row) => row.project === undefined)).toMatchObject({ replies: count - inProject });
    });

    it("sweeps the usage of an organization deleted without its erasure job, and keeps an existing one's", async () => {
        const kept = await insert("organization", { createdAt: 1, name: "Kept", slug: "kept" });
        const gone = await insert("organization", { createdAt: 1, name: "Gone", slug: "gone" });

        await harness.run(async (ctx: any) => {
            await ctx.db.delete("organization", gone);

            for (const [index, organizationId] of [kept, gone, gone].entries()) {
                await ctx.db.insert("usageOrganizationReplies", {
                    costMicrodollars: 1,
                    date: "2026-09-20",
                    organizationId,
                    recordedAt: 0,
                    replyKey: `swept-${String(index)}`,
                    tokens: 1,
                    userId: MEMBER,
                });
            }
        });

        expect(await harness.run(async (ctx: any) => await ctx.runMutation(sweepOrphanedOrganizationUsage, {}))).toBe(2);

        const left = await harness.run(async (ctx: any) => {
            const { page } = await ctx.db.usageOrganizationReplies.findMany({ where: { userId: MEMBER } });

            return page.map((row: { organizationId: string }) => row.organizationId);
        });

        expect(left).toStrictEqual([kept]);
    });

    it("erases a deleted organization's usage", async () => {
        await insert("member", { createdAt: 0, organizationId: ORG, role: "member", userId: MEMBER });
        await record(MEMBER, await insert("threads", { organizationId: ORG, status: "active", title: "T", userId: MEMBER }), 20);

        expect(await harness.run(async (ctx: any) => await ctx.runMutation(eraseOrganizationUsage, { organizationId: ORG }))).toBe(1);

        const { result } = await read();

        expect(result.total.costMicrodollars).toBe(0);
    });

    it("starts the period at the viewer's midnight, whichever zone dated each member's reply", async () => {
        // The admin counts days in Tokyo: the period from FROM starts at 2026-08-31T15:00Z.
        const start = Date.UTC(2026, 7, 31, 15);

        await insert("userSettings", { timezone: "Asia/Tokyo", userId: ADMIN });
        await harness.run(async (ctx: any) => {
            // Both dated FROM by a member in Los Angeles; only the second is inside the admin's period.
            for (const [index, recordedAt] of [start - 60_000, start + 60_000].entries()) {
                await ctx.db.insert("usageOrganizationReplies", {
                    costMicrodollars: 10 * (index + 1),
                    date: FROM,
                    organizationId: ORG,
                    recordedAt,
                    replyKey: `zone-${String(index)}`,
                    tokens: 1,
                    userId: MEMBER,
                });
            }
        });

        const { result } = await read();

        expect(result.total).toMatchObject({ costMicrodollars: 20, replies: 1 });
    });

    it("titles projects with usage across several lookups and lists those with none once", async () => {
        const withUsage = 52;
        const ids: string[] = [];

        await harness.run(async (ctx: any) => {
            for (let index = 0; index < withUsage + 3; index += 1) {
                ids.push(await ctx.db.insert("projects", { createdAt: 0, organizationId: ORG, title: `P${String(index)}`, userId: ADMIN }));
            }

            for (const [index, projectKey] of ids.slice(0, withUsage).entries()) {
                await ctx.db.insert("usageOrganizationReplies", {
                    costMicrodollars: index + 1,
                    date: "2026-09-20",
                    organizationId: ORG,
                    projectKey,
                    recordedAt: AT,
                    replyKey: `titled-${String(index)}`,
                    tokens: 1,
                    userId: ADMIN,
                });
            }
        });

        const { result } = await read();

        expect(result.projects).toHaveLength(withUsage + 3);
        expect(new Set(result.projects.map((project) => project.projectKey)).size).toBe(withUsage + 3);
        expect(result.projects.filter((project) => project.costMicrodollars === 0)).toHaveLength(3);
    });

    it("says when projects with no usage are left out, without calling the period incomplete", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index <= MAX_PROJECTS; index += 1) {
                await ctx.db.insert("projects", { createdAt: 0, organizationId: ORG, title: `P${String(index)}`, userId: ADMIN });
            }
        });

        const { result } = await read();

        expect(result.projectsCut).toBe(true);
    });
});

describe("organization usage of shared threads and former members", () => {
    it("files a reply in a teammate's shared thread under that thread's project and organization", async () => {
        const project = await insert("projects", { createdAt: 0, organizationId: ORG, title: "Org project", userId: ADMIN });
        // The admin's thread; the member replies in it, and the record is forwarded from the thread's shard.
        const thread = await insert("threads", { organizationId: ORG, projectId: project, status: "active", title: "T", userId: ADMIN });

        await insert("member", { createdAt: 0, organizationId: ORG, role: "member", userId: MEMBER });
        await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(forwardReplyUsage, {
                    at: AT,
                    costMicrodollars: 40,
                    date: "2026-09-20",
                    replyKey: "shared-reply",
                    skillKey: DEFAULT_SKILL_KEY,
                    threadId: thread,
                    tokens: 1,
                    userId: MEMBER,
                }),
        );

        // The member's shard records it, with what the thread's shard worked out.
        expect(harnessRef.forwarded).toMatchObject([{ threadAttribution: { organizationId: ORG, projectInOrganization: true, projectKey: project } }]);

        for (const forwarded of harnessRef.forwarded) {
            await harness.run(async (ctx: any) => await ctx.runMutation(recordReplyUsage, forwarded));
        }

        const { result } = await read();

        expect(result.total.costMicrodollars).toBe(40);
        expect(result.projects).toMatchObject([{ costMicrodollars: 40, projectKey: project }]);
    });

    it("files no project for a reply in a teammate's thread that sits in the teammate's personal project", async () => {
        const personal = await insert("projects", { createdAt: 0, title: "Admin's own", userId: ADMIN });
        const thread = await insert("threads", { organizationId: ORG, projectId: personal, status: "active", title: "T", userId: ADMIN });

        await insert("member", { createdAt: 0, organizationId: ORG, role: "member", userId: MEMBER });
        await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(forwardReplyUsage, {
                    at: AT,
                    costMicrodollars: 40,
                    date: "2026-09-20",
                    replyKey: "personal-shared",
                    skillKey: DEFAULT_SKILL_KEY,
                    threadId: thread,
                    tokens: 1,
                    userId: MEMBER,
                }),
        );

        // The member cannot open the admin's personal project: the record carries the organization alone.
        expect(harnessRef.forwarded).toMatchObject([{ threadAttribution: { organizationId: ORG } }]);
        expect(harnessRef.forwarded[0]!.threadAttribution).not.toHaveProperty("projectKey");
    });

    it("files nothing under an organization for someone who is no longer its member", async () => {
        const membership = await insert("member", { createdAt: 0, organizationId: ORG, role: "member", userId: MEMBER });
        const thread = await insert("threads", { organizationId: ORG, status: "active", title: "T", userId: MEMBER });

        await harness.run(async (ctx: any) => {
            await ctx.db.delete("member", membership);
        });
        await record(MEMBER, thread, 70);

        const { result } = await read();

        expect(result.total.costMicrodollars).toBe(0);
    });
});

describe("isOrganizationAdminRole", () => {
    it("reads each of a member's comma-separated roles", () => {
        expect(isOrganizationAdminRole("admin,member")).toBe(true);
        expect(isOrganizationAdminRole("member, owner")).toBe(true);
        expect(isOrganizationAdminRole("member")).toBe(false);
    });
});
