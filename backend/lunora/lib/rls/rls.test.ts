/**
 * Row-level security as defence in depth (`lib/rls/`).
 *
 * The first half builds TEST-ONLY procedures on the real builders that do no
 * authorization at all — the shape of a procedure that forgot its check — and
 * shows the policies still refuse a stranger. The second half drives real
 * procedures through every sharing rule the policies must keep working: thread
 * grants, public share tokens, page grants, organization-shared rows, platform
 * admins, and internal (system) functions.
 */
import { lunoraTest } from "@lunora/testing";
import { v } from "lunorash/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi } from "../../../test/registered-api";

import { schemaWithShardedTables } from "../test-schema";
import { adminQuery, authMutation, authQuery, internalQuery, mutation, publicQuery, query } from "../crpc";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

const MODULES = {
    agent_messages: async () => await import("../../agent/messages"),
    chat_functions: async () => await import("../../chat/functions"),
    chat_sharing: async () => await import("../../chat/sharing"),
    pages_functions: async () => await import("../../pages/functions"),
    pages_sharing: async () => await import("../../pages/sharing"),
    prompts_functions: async () => await import("../../prompts/functions"),
} as const;

const procedureAt = (module: keyof typeof MODULES, name: string): never => {
    const procedure = registry.get(`${module}:${name}`);

    if (!procedure) {
        throw new Error(`rls.test: ${module}.${name} is not exported`);
    }

    return procedure as never;
};

beforeAll(async () => {
    for (const [module, load] of Object.entries(MODULES)) {
        const exports = await load();

        for (const [name, value] of Object.entries(exports)) {
            registry.set(`${module}:${name}`, value);
        }
    }
});

const OWNER = "user-owner";
const GRANTEE = "user-grantee";
const STRANGER = "user-stranger";
const ADMIN = "user-admin";
const ORG = "org-shared";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) => {
            const { userId } = context.auth;

            if (!userId) {
                return null;
            }

            // OWNER and GRANTEE share an active organization; STRANGER is in none.
            const org = userId === "user-owner" || userId === "user-grantee" ? "org-shared" : null;

            return {
                activeOrganization: org ? { id: org, name: org, role: "member", slug: org } : null,
                email: `${userId}@example.com`,
                id: userId,
                isAdmin: userId === "user-admin",
                name: userId,
                plan: "free",
                userId,
            };
        },
    };
});

vi.mock("../crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
        getSessionUserWithAnonymous: sessionFrom,
    };
});

vi.mock("../../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

vi.mock("../rate-limiter", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../rate-limiter")>()), rateLimitGuard: async () => undefined };
});

// `prompts` is audited, and its trigger writes the `.global()` `documentHistory`
// table the harness cannot store. Auditing is not what is under test.
vi.mock("../audit-triggers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../audit-triggers")>()),
        auditTriggersFor: () => {
            return {};
        },
    };
});

// ─── Procedures that forgot their check ──────────────────────────────────────

const byId = { id: v.string() };

const DENIED = /denied by policy/u;
const ADMIN_REQUIRED = /admin/iu;

/** Reads any row by id. No ownership check. */
const leakyGet = authQuery
    .input(byId)
    .output(v.any())
    .query(async ({ args, ctx }) => await ctx.db.get(args.id as never));

/** Lists a thread's messages two ways (legacy index read, ORM facade). No check. */
const leakyMessages = authQuery
    .input(byId)
    .output(v.any())
    .query(async ({ args, ctx }) => {
        const viaIndex = await ctx.db
            .query("messages")
            .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", args.id as never))
            .collect();
        const viaFacade = await ctx.db.messages.findMany({ where: { threadId: args.id as never } });

        return { viaFacade: viaFacade.page.length, viaIndex: viaIndex.length };
    });

/** Retitles any thread. No check. */
const leakyPatch = authMutation
    .input(byId)
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await ctx.db.patch(args.id as never, { title: "pwned" } as never);

        return null;
    });

/** Deletes any memory. No check. */
const leakyDelete = authMutation
    .input(byId)
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await ctx.db.delete(args.id as never);

        return null;
    });

/** Plants a memory in someone else's name. No check. */
const leakyInsert = authMutation
    .input({ userId: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await ctx.db.insert("memories", { createdAt: 0, importance: 1, memory: "planted", type: "preference", updatedAt: 0, userId: args.userId } as never);

        return null;
    });

/** The bare builders (`agent/*`, `auth/functions.ts`) resolve identity themselves — guarded all the same. */
const leakyBareGet = query
    .input(byId)
    .output(v.any())
    .query(async ({ args, ctx }) => await ctx.db.get(args.id as never));

const leakyBarePatch = mutation
    .input(byId)
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await ctx.db.patch(args.id as never, { title: "pwned" } as never);

        return null;
    });

/** Anonymous callers too. */
const leakyPublicGet = publicQuery
    .input(byId)
    .output(v.any())
    .query(async ({ args, ctx }) => await ctx.db.get(args.id as never));

/** A platform admin procedure: the policies step aside, the admin role is the check. */
const adminGet = adminQuery
    .input(byId)
    .output(v.any())
    .query(async ({ args, ctx }) => await ctx.db.get(args.id as never));

/** Internal functions are system code: built without the RLS middleware. */
const systemGet = internalQuery
    .input(byId)
    .output(v.any())
    .query(async ({ args, ctx }) => await ctx.db.get(args.id as never));

// ─── Harness ─────────────────────────────────────────────────────────────────

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

const as = (userId: string) => harness.withIdentity({ userId } as never);
const run = async <T>(body: (context: any) => Promise<T>): Promise<T> => await harness.run(body);

const seedThread = async (extra: Record<string, unknown> = {}) =>
    await run(async (context) => {
        const threadId = await context.db.insert("threads", { status: "active", title: "private", userId: OWNER, ...extra });

        await context.db.insert("messages", {
            message: { content: "secret", role: "user" },
            order: 0,
            status: "success",
            stepOrder: 0,
            text: "secret",
            threadId,
            tool: false,
            userId: OWNER,
        });

        return threadId as string;
    });

beforeEach(() => {
    // The `.global()` tables these tests seed; the harness has no D1 backend (see lib/test-schema.ts).
    harness = lunoraTest(schemaWithShardedTables(["projects", "prompts", "promptHistory", "userVariableDefaults"]) as never);
});

afterEach(() => {
    harness.close();
});

describe("a procedure that forgot its check", () => {
    it("reads nothing of a stranger's: not the thread, not its messages", async () => {
        const threadId = await seedThread();

        expect(await as(STRANGER).query(leakyGet as never, { id: threadId } as never)).toBeNull();
        expect(await as(STRANGER).query(leakyMessages as never, { id: threadId } as never)).toEqual({ viaFacade: 0, viaIndex: 0 });
        expect(await as(STRANGER).query(leakyBareGet as never, { id: threadId } as never)).toBeNull();
        expect(await harness.query(leakyPublicGet as never, { id: threadId } as never)).toBeNull();

        // The same procedures still serve the owner.
        expect(await as(OWNER).query(leakyGet as never, { id: threadId } as never)).toMatchObject({ userId: OWNER });
        expect(await as(OWNER).query(leakyMessages as never, { id: threadId } as never)).toEqual({ viaFacade: 1, viaIndex: 1 });
    });

    it("writes nothing of a stranger's: patch, delete and a planted insert are refused", async () => {
        const threadId = await seedThread();
        const memoryId = await run(
            async (context) =>
                await context.db.insert("memories", { createdAt: 0, importance: 1, memory: "mine", type: "preference", updatedAt: 0, userId: OWNER }),
        );

        await expect(as(STRANGER).mutation(leakyPatch as never, { id: threadId } as never)).rejects.toThrow(DENIED);
        await expect(as(STRANGER).mutation(leakyBarePatch as never, { id: threadId } as never)).rejects.toThrow(DENIED);
        await expect(as(STRANGER).mutation(leakyDelete as never, { id: memoryId } as never)).rejects.toThrow(DENIED);
        await expect(as(STRANGER).mutation(leakyInsert as never, { userId: OWNER } as never)).rejects.toThrow(DENIED);

        const titleOf = async () =>
            await run(async (context) => {
                const thread = await context.db.get(threadId);

                return thread.title;
            });

        expect(await titleOf()).toBe("private");
        expect(await run(async (context) => await context.db.get(memoryId))).not.toBeNull();

        // The owner's own writes pass.
        await as(OWNER).mutation(leakyPatch as never, { id: threadId } as never);
        expect(await titleOf()).toBe("pwned");
    });

    it("steps aside for platform admins and for internal functions", async () => {
        const threadId = await seedThread();

        expect(await as(ADMIN).query(adminGet as never, { id: threadId } as never)).toMatchObject({ userId: OWNER });
        // A non-admin never reaches the handler of an admin procedure.
        await expect(as(STRANGER).query(adminGet as never, { id: threadId } as never)).rejects.toThrow(ADMIN_REQUIRED);
        // An internal function (the scheduler, the jobs queue, a cron) sees every row.
        expect(await run(async (context) => await (systemGet as any).handler(context, { id: threadId }))).toMatchObject({ userId: OWNER });
    });
});

describe("shared access still works", () => {
    it("a live thread grant reads the owner's thread and messages; a stranger does not", async () => {
        const threadId = await seedThread();

        await run(async (context) => {
            await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "read", threadId, userId: GRANTEE });
        });

        const args = { order: "asc", paginationOpts: { cursor: null, numItems: 10 }, threadId };
        const granted = (await as(GRANTEE).query(procedureAt("agent_messages", "listMessagesByThreadId"), args as never)) as { page: unknown[] };

        expect(granted.page).toHaveLength(1);
        expect(((await as(STRANGER).query(procedureAt("agent_messages", "listMessagesByThreadId"), args as never)) as { page: unknown[] }).page).toEqual([]);

        // The grant admitted THIS thread only: the grantee's forgetful reads of it
        // now pass, a second private thread of the owner's stays hidden.
        const other = await seedThread();

        expect(await as(GRANTEE).query(leakyGet as never, { id: other } as never)).toBeNull();
    });

    it("an expired grant admits nothing", async () => {
        const threadId = await seedThread();

        await run(async (context) => {
            await context.db.insert("threadAccess", { expiresAt: 1, grantedAt: 0, grantedBy: OWNER, permission: "read", threadId, userId: GRANTEE });
        });

        const expired = (await as(GRANTEE).query(procedureAt("agent_messages", "listMessagesByThreadId"), {
            order: "asc",
            paginationOpts: { cursor: null, numItems: 10 },
            threadId,
        } as never)) as { page: unknown[] };

        expect(expired.page).toEqual([]);
        expect(await as(GRANTEE).query(leakyGet as never, { id: threadId } as never)).toBeNull();
    });

    it("the public share token shows an anonymous viewer the thread", async () => {
        await seedThread({ isPublic: true, publicAccessToken: "share-token" });
        // What `toggleThreadVisibility` records: the token's route to the owner's shard.
        await run(async (context) => {
            await context.db.insert("shardRoutes", { createdAt: 0, key: "thread-public:share-token", ownerId: OWNER });
        });

        const shared = (await harness.action(procedureAt("chat_sharing", "getPublicThread"), { publicAccessToken: "share-token" } as never)) as {
            messages: unknown[];
        } | null;

        expect(shared?.messages).toHaveLength(1);
        expect(await harness.action(procedureAt("chat_sharing", "getPublicThread"), { publicAccessToken: "wrong" } as never)).toBeNull();
    });

    it("a page grant reads the owner's page and lists it; a stranger gets neither", async () => {
        const pageId = await run(async (context) => {
            const id = await context.db.insert("pages", {
                contentRevision: 0,
                createdAt: 0,
                order: 0,
                revision: 0,
                title: "Plan",
                updatedAt: 0,
                userId: OWNER,
            });

            await context.db.insert("pageAccess", { grantedAt: 0, grantedBy: OWNER, ownerId: OWNER, pageId: id, permission: "comment", userId: GRANTEE });
            await context.db.insert("pageComments", {
                authorName: OWNER,
                body: "note",
                commentId: "c1",
                createdAt: 0,
                pageId: id,
                status: "open",
                userId: OWNER,
            });

            return id as string;
        });

        expect(await as(GRANTEE).query(procedureAt("pages_functions", "getPage"), { pageId } as never)).toMatchObject({ title: "Plan" });

        const tree = (await as(GRANTEE).query(procedureAt("pages_functions", "listPageTree"), {} as never)) as { shared: { _id: string }[] };

        expect(tree.shared.map((page) => page._id)).toEqual([pageId]);
        await expect(as(STRANGER).query(procedureAt("pages_functions", "getPage"), { pageId } as never)).rejects.toThrow();
        expect(await as(STRANGER).query(leakyGet as never, { id: pageId } as never)).toBeNull();
    });

    it("a public page token reads the page anonymously", async () => {
        await run(async (context) => {
            await context.db.insert("pages", {
                contentRevision: 0,
                createdAt: 0,
                isPublic: true,
                order: 0,
                publicAccessToken: "page-token",
                revision: 0,
                title: "Public plan",
                updatedAt: 0,
                userId: OWNER,
            });
            // What `setPagePublic` records: the token's route to the owner's shard.
            await context.db.insert("shardRoutes", { createdAt: 0, key: "page-public:page-token", ownerId: OWNER });
        });

        expect(await harness.action(procedureAt("pages_sharing", "getPublicPage"), { publicAccessToken: "page-token" } as never)).toMatchObject({
            title: "Public plan",
        });
    });

    it("an organization-shared prompt reads for a member of that organization, not for anyone else", async () => {
        const promptId = await run(
            async (context) => await context.db.insert("prompts", { content: "shared body", name: "Shared", organizationId: ORG, userId: OWNER }),
        );

        expect(await as(GRANTEE).query(procedureAt("prompts_functions", "getPrompt"), { promptId } as never)).toMatchObject({ name: "Shared" });
        expect(await as(STRANGER).query(leakyGet as never, { id: promptId } as never)).toBeNull();
    });
});
