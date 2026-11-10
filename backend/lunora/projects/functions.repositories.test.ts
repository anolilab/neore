/**
 * A project's repositories, one row each: changed by its owner only (a member for an organization project nobody
 * owns), stored normalised, listed with one default.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import schema from "../schema";
import {
    addProjectRepo,
    deleteProject,
    findRepoProject,
    listProjectRepos,
    removeProjectRepo,
    setDefaultProjectRepo,
    underDeleteMarker,
    updateProject,
    updateProjectRepo,
} from "./functions";
import { eraseOrganizationRepositories, sweepOrphanedOrganizationRepositories } from "./gdpr";
import { MAX_PROJECT_REPOSITORIES } from "./repositories";

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const MEMBER = "user-member";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

// The caller's active organization, for a test that moves a project between organizations.
const { activeOrganization, sessionFrom } = vi.hoisted(() => {
    const active: { id?: string } = {};

    return {
        activeOrganization: active,
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId
                ? {
                      activeOrganization: active.id ? { id: active.id } : null,
                      id: context.auth.userId,
                      userId: context.auth.userId,
                  }
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

// Runs once just before the add re-reads its project from the primary, inside that mutation: a change made meanwhile.
const { meanwhile } = vi.hoisted(() => {
    return { meanwhile: {} as { run?: (db: any) => Promise<void> } };
});

vi.mock("../lib/rls/scope", async (importOriginal) => {
    const original = await importOriginal<typeof import("../lib/rls/scope")>();

    return {
        ...original,
        systemDb: (context: any) => {
            const db = original.systemDb(context);
            const findFirst = async (query: { consistency?: string }) => {
                const run = query.consistency === "primary" ? meanwhile.run : undefined;

                if (run) {
                    delete meanwhile.run;
                    await run(db);
                }

                return await db.projects.findFirst(query);
            };

            return new Proxy(db, { get: (target, key) => (key === "projects" ? { ...target.projects, findFirst } : target[key]) });
        },
    };
});

vi.mock("../lib/audit-triggers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/audit-triggers")>()),
        auditTriggersFor: () => {
            return {};
        },
    };
});

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

let harness: ReturnType<typeof lunoraTest>;

beforeAll(async () => {
    registerModule(registry, "projects_functions", await import("./functions"));
    registerModule(registry, "agent_projects", await import("../agent/projects"));
}, 30_000);

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("project repositories", () => {
    const projectOf = async (fields: Record<string, unknown>) =>
        (await harness.run(async (ctx: any) => await ctx.db.insert("projects", { createdAt: 0, title: "p", ...fields }))) as string;
    const as = (userId: string) => harness.withIdentity({ userId });
    const add = (userId: string, projectId: string, url: string, defaultBranch?: string) =>
        as(userId).mutation(addProjectRepo as never, { projectId, url, ...(defaultBranch && { defaultBranch }) } as never) as Promise<string>;
    const list = (userId: string, projectId: string) =>
        as(userId).query(listProjectRepos as never, { projectId } as never) as Promise<
            { defaultBranch?: string; id: string; isDefault: boolean; url: string }[]
        >;

    it("adds repositories one at a time, stored normalised, the first as the default", async () => {
        const projectId = await projectOf({ userId: OWNER });

        await add(OWNER, projectId, "acme/web");
        await add(OWNER, projectId, "https://github.com/acme/api", " develop ");

        expect(await list(OWNER, projectId)).toMatchObject([
            { isDefault: true, url: "https://github.com/acme/web.git" },
            { defaultBranch: "develop", isDefault: false, url: "https://github.com/acme/api.git" },
        ]);
    });

    it("lets the owner, and a member only on a project nobody owns, change the list; tells a stranger nothing", async () => {
        const organizationId = "org-1";
        const [owned, shared] = (await harness.run(async (ctx: any) => {
            await ctx.db.insert("member", { createdAt: 1, organizationId, role: "member", userId: MEMBER });

            return [
                await ctx.db.insert("projects", { createdAt: 0, organizationId, title: "owned", userId: OWNER }),
                await ctx.db.insert("projects", { createdAt: 0, organizationId, title: "shared" }),
            ];
        })) as [string, string];
        const repoId = await add(OWNER, owned, "acme/web");

        await expect(add(MEMBER, owned, "acme/api")).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(as(MEMBER).mutation(removeProjectRepo as never, { repoId } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(add(MEMBER, shared, "acme/api")).resolves.toBeTypeOf("string");
        await expect(list(MEMBER, owned)).resolves.toHaveLength(1);
        await expect(list(STRANGER, owned)).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(as(STRANGER).mutation(setDefaultProjectRepo as never, { repoId } as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("refuses a repeated repo and a bad entry, naming the field to correct", async () => {
        const projectId = await projectOf({ userId: OWNER });

        await add(OWNER, projectId, "acme/web");

        await expect(add(OWNER, projectId, "https://github.com/acme/web.git")).rejects.toMatchObject({ data: { field: "url", reason: "duplicate" } });
        await expect(add(OWNER, projectId, "ssh://example.com/x")).rejects.toMatchObject({ data: { field: "url", reason: "invalidUrl" } });
        await expect(add(OWNER, projectId, "acme/api", "--upload-pack=x")).rejects.toMatchObject({ data: { field: "defaultBranch", reason: "invalidBranch" } });
        await expect(list(OWNER, projectId)).resolves.toHaveLength(1);
    });

    it("refuses an add that would pass the cap and takes its row back", async () => {
        const projectId = await projectOf({ userId: OWNER });

        // The rows a concurrent writer already holds, staged directly: the harness runs mutations one after another.
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < MAX_PROJECT_REPOSITORIES; index += 1) {
                await ctx.db.insert("projectRepositories", { createdAt: 0, projectId, url: `https://github.com/acme/r${String(index)}.git` });
            }
        });

        await expect(add(OWNER, projectId, "acme/one-more")).rejects.toMatchObject({ data: { reason: "limit" } });
        await expect(list(OWNER, projectId)).resolves.toHaveLength(MAX_PROJECT_REPOSITORIES);
    });

    it("moves the default with one write, falls back to the first when it is removed, and edits a branch", async () => {
        const projectId = await projectOf({ userId: OWNER });

        await add(OWNER, projectId, "acme/web");
        const api = await add(OWNER, projectId, "acme/api");

        await as(OWNER).mutation(setDefaultProjectRepo as never, { repoId: api } as never);
        const afterPick = await list(OWNER, projectId);

        expect(afterPick.find((repo) => repo.isDefault)?.url).toBe("https://github.com/acme/api.git");

        await expect(as(OWNER).mutation(updateProjectRepo as never, { defaultBranch: "main", repoId: api, revision: 0 } as never)).resolves.toBe(1);
        const afterEdit = await list(OWNER, projectId);

        expect(afterEdit.find((repo) => repo.id === api)?.defaultBranch).toBe("main");

        // A save naming a revision older than the stored one arrived late: refused, the newer branch stays.
        await expect(as(OWNER).mutation(updateProjectRepo as never, { defaultBranch: "old", repoId: api, revision: 0 } as never)).rejects.toMatchObject({
            code: "CONFLICT",
            data: { reason: "stale", revision: 1 },
        });
        const afterStale = await list(OWNER, projectId);

        expect(afterStale.find((repo) => repo.id === api)?.defaultBranch).toBe("main");

        // A blank branch clears it with a field-only patch: the default pick on the row stays.
        await as(OWNER).mutation(updateProjectRepo as never, { defaultBranch: " ", repoId: api, revision: 1 } as never);
        const afterClear = await list(OWNER, projectId);

        expect(afterClear.find((repo) => repo.id === api)).toStrictEqual({
            id: api,
            isDefault: true,
            revision: 2,
            url: "https://github.com/acme/api.git",
        });

        await as(OWNER).mutation(removeProjectRepo as never, { repoId: api } as never);
        expect(await list(OWNER, projectId)).toMatchObject([{ isDefault: true, url: "https://github.com/acme/web.git" }]);
    });

    it("lets a later pick win within the same millisecond", async () => {
        vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });

        try {
            const projectId = await projectOf({ userId: OWNER });
            const web = await add(OWNER, projectId, "acme/web");
            const api = await add(OWNER, projectId, "acme/api");

            await as(OWNER).mutation(setDefaultProjectRepo as never, { repoId: api } as never);
            await as(OWNER).mutation(setDefaultProjectRepo as never, { repoId: web } as never);

            const repos = await list(OWNER, projectId);

            expect(repos.find((repo) => repo.isDefault)?.id).toBe(web);
        } finally {
            vi.useRealTimers();
        }
    });

    it("finds the caller's project that lists a repository, past 60 other accounts listing it, and nobody else's", async () => {
        // Other accounts' rows, staged as `addProjectRepo` writes them, created before the caller's.
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 60; index += 1) {
                const userId = `user-other-${String(index)}`;
                const other = await ctx.db.insert("projects", { createdAt: 0, title: "other", userId });

                await ctx.db.insert("projectRepositories", { createdAt: 0, projectId: other, url: "https://github.com/acme/web.git", userId });
            }
        });

        const projectId = await projectOf({ title: "Web", userId: OWNER });

        await add(OWNER, projectId, "acme/web");

        const find = (userId: string, url: string) => as(userId).query(findRepoProject as never, { url } as never);

        await expect(find(OWNER, "https://github.com/acme/web")).resolves.toStrictEqual({ projectId, title: "Web" });
        await expect(find(STRANGER, "acme/web")).resolves.toBeNull();
        await expect(find(OWNER, "not a repo")).resolves.toBeNull();
    });

    it("leaves no row from an add that races a project delete", async () => {
        const projectId = await projectOf({ userId: OWNER });
        const rows = async () =>
            await harness.run(async (ctx: any) => {
                const { page } = await ctx.db.projectRepositories.findMany({ where: { projectId } });

                return page;
            });

        // A delete in progress has written its marker: the add refuses and writes nothing.
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("projectRepositories", { createdAt: 0, deletingAt: Date.now(), projectId, url: "", userId: OWNER });
        });
        await expect(add(OWNER, projectId, "acme/web")).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(await rows()).toHaveLength(1);

        // An add whose row landed before the marker: the delete erases it, and its own marker.
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("projectRepositories", { createdAt: 0, projectId, url: "https://github.com/acme/api.git", userId: OWNER });
        });
        await as(OWNER).mutation(deleteProject as never, { projectId } as never);
        expect(await rows()).toStrictEqual([]);
    });

    it("takes a failed delete's marker back, so the project takes repositories again at once", async () => {
        const projectId = await projectOf({ userId: OWNER });

        // The delete itself fails after its marker is written (a failed check, a thread move, a transient error).
        await harness.run(async (ctx: any) => {
            await expect(
                underDeleteMarker(ctx, projectId as never, { userId: OWNER }, async () => {
                    throw new Error("delete failed");
                }),
            ).rejects.toThrow("delete failed");
        });

        await expect(add(OWNER, projectId, "acme/web")).resolves.toBeTypeOf("string");
    });

    it("refuses an add when the project moved to an organization the member is not in, and keeps no row", async () => {
        const projectId = await projectOf({ organizationId: "org-1" });

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("member", { createdAt: 1, organizationId: "org-1", role: "member", userId: MEMBER });
        });
        // The move lands after the member's access was checked, before the add checks its row.
        meanwhile.run = async (db) => {
            await db.patch("projects", projectId, { organizationId: "org-2" });
        };

        await expect(add(MEMBER, projectId, "acme/web")).rejects.toMatchObject({ code: "NOT_FOUND" });

        const rows = await harness.run(async (ctx: any) => (await ctx.db.projectRepositories.findMany({ where: { projectId } })).page);

        expect(rows).toStrictEqual([]);
    });

    it("moves a project's repositories with it when the project changes organization", async () => {
        const projectId = await projectOf({ organizationId: "org-1", userId: OWNER });

        await add(OWNER, projectId, "acme/web");
        activeOrganization.id = "org-2";

        try {
            await as(OWNER).mutation(updateProject as never, { patch: { organizationId: "org-2" }, projectId } as never);
        } finally {
            delete activeOrganization.id;
        }

        const rows = await harness.run(async (ctx: any) => {
            const { page } = await ctx.db.projectRepositories.findMany({ where: { projectId } });

            return page;
        });

        expect(rows.map((row: { organizationId?: string }) => row.organizationId)).toStrictEqual(["org-2"]);
    });

    it("erases a deleted organization's repository rows, but not those of a project someone in it owns", async () => {
        const urlsLeft = async () =>
            await harness.run(async (ctx: any) => {
                const { page } = await ctx.db.projectRepositories.findMany({});

                return page.map((row: { url: string }) => row.url).toSorted((left: string, right: string) => left.localeCompare(right));
            });
        const organizationId = (await harness.run(async (ctx: any) => {
            const id = await ctx.db.insert("organization", { createdAt: 1, name: "Acme", slug: "acme" });
            const projects = [
                await ctx.db.insert("projects", { createdAt: 0, organizationId: id, title: "shared" }),
                await ctx.db.insert("projects", { createdAt: 0, organizationId: id, title: "owned", userId: OWNER }),
            ];

            await ctx.db.insert("projectRepositories", { createdAt: 0, organizationId: id, projectId: projects[0], url: "https://github.com/acme/shared.git" });
            await ctx.db.insert("projectRepositories", {
                createdAt: 0,
                organizationId: id,
                projectId: projects[1],
                url: "https://github.com/acme/owned.git",
                userId: OWNER,
            });

            return id;
        })) as string;

        // The daily sweep leaves an organization that still exists alone.
        await harness.run(async (ctx: any) => await ctx.runMutation(sweepOrphanedOrganizationRepositories, {}));
        expect(await urlsLeft()).toHaveLength(2);

        // Deleting it: the job queued from the delete route, and the sweep behind it, erase only the ownerless rows.
        await harness.run(async (ctx: any) => {
            await ctx.db.delete("organization", organizationId);
        });
        await harness.run(async (ctx: any) => await ctx.runMutation(eraseOrganizationRepositories, { organizationId }));
        expect(await urlsLeft()).toStrictEqual(["https://github.com/acme/owned.git"]);
    });

    it("sweeps an organization's leftover repository rows once the organization is gone", async () => {
        const projectId = await harness.run(async (ctx: any) => {
            const organizationId = await ctx.db.insert("organization", { createdAt: 1, name: "Gone", slug: "gone" });
            const id = await ctx.db.insert("projects", { createdAt: 0, organizationId, title: "shared" });

            await ctx.db.insert("projectRepositories", { createdAt: 0, organizationId, projectId: id, url: "https://github.com/gone/r.git" });
            // A delete's marker a failed final erase left behind, stamped with the organization like the rows.
            await ctx.db.insert("projectRepositories", { createdAt: 0, deletingAt: 0, organizationId, projectId: id, url: "" });
            await ctx.db.delete("organization", organizationId);

            return id;
        });

        await harness.run(async (ctx: any) => await ctx.runMutation(sweepOrphanedOrganizationRepositories, {}));

        const left = await harness.run(async (ctx: any) => {
            const { page } = await ctx.db.projectRepositories.findMany({ where: { projectId } });

            return page;
        });

        expect(left).toStrictEqual([]);
    });

    it("deletes a project that lists repositories: the delete succeeds and takes every row, its marker included", async () => {
        const projectId = await projectOf({ userId: OWNER });

        await add(OWNER, projectId, "acme/web");
        await add(OWNER, projectId, "acme/api");
        await expect(as(OWNER).mutation(deleteProject as never, { projectId } as never)).resolves.toStrictEqual({ success: true });

        const project = await harness.run(async (ctx: any) => await ctx.db.projects.findFirst({ where: { _id: projectId } }));

        expect(project).toBeNull();

        const left = await harness.run(async (ctx: any) => await ctx.db.projectRepositories.findMany({ where: { projectId } }));

        expect(left.page).toStrictEqual([]);
    });
});
