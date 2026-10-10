/**
 * Knowledge collections: CRUD and ownership, organization sharing, filing
 * files, attaching to threads and projects, and the retrieval scope a thread
 * resolves to — driven through the real procedures with row-level security on.
 *
 * The harness is one database standing in for every shard (and `callOnShard`
 * dispatches into it), so "on the owner's shard" is asserted by who may read,
 * not by where rows live.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi } from "../../test/registered-api";

import { schemaWithShardedTables } from "../lib/test-schema";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

const MODULES = {
    knowledge_collections: async () => await import("./collections"),
    knowledge_documents: async () => await import("./documents"),
    knowledge_functions: async () => await import("./functions"),
    knowledge_housekeeping: async () => await import("./housekeeping"),
} as const;

const procedureAt = (module: keyof typeof MODULES, name: string): never => {
    const procedure = registry.get(`${module}:${name}`);

    if (!procedure) {
        throw new Error(`collections.test: ${module}.${name} is not exported`);
    }

    return procedure as never;
};

beforeAll(async () => {
    for (const [module, load] of Object.entries(MODULES)) {
        const exported = await load();

        for (const [name, value] of Object.entries(exported)) {
            registry.set(`${module}:${name}`, value);
        }
    }
});

const OWNER = "user-owner";
const MATE = "user-mate";
const STRANGER = "user-stranger";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) => {
            const { userId } = context.auth;

            if (!userId) {
                return null;
            }

            // OWNER and MATE are in the same active organization; STRANGER is in none.
            const org = userId === "user-owner" || userId === "user-mate" ? "org-team" : null;

            return {
                activeOrganization: org ? { id: org, name: "Team", role: "member", slug: org } : null,
                email: `${userId}@example.com`,
                id: userId,
                isAdmin: false,
                name: userId,
                userId,
            };
        },
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
        getSessionUserWithAnonymous: sessionFrom,
    };
});

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

// Membership rows live in the `.global()` better-auth table the harness cannot hold.
vi.mock("../auth/lib/better-auth-queries", async (importOriginal) => {
    const members: Record<string, string[]> = { "org-team": ["user-owner", "user-mate"] };

    return {
        ...(await importOriginal<typeof import("../auth/lib/better-auth-queries")>()),
        getMemberByOrganizationAndUser: async (_context: unknown, organizationId: string, userId: string) =>
            (members[organizationId] ?? []).includes(userId) ? { organizationId, role: "member", userId } : null,
        getMembersByUserId: async (_context: unknown, userId: string) =>
            Object.entries(members)
                .filter(([, ids]) => ids.includes(userId))
                .map(([organizationId]) => {
                    return { organizationId, role: "member", userId };
                }),
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async () => undefined,
    };
});

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

const as = (userId: string) => harness.withIdentity({ userId } as never);
const run = async <T>(body: (context: any) => Promise<T>): Promise<T> => await harness.run(body);

const create = async (userId: string, name: string, share = false): Promise<string> =>
    (await as(userId).mutation(procedureAt("knowledge_collections", "createCollection"), { name, shareWithOrganization: share } as never)) as string;

const list = async (userId: string) =>
    (await as(userId).query(procedureAt("knowledge_collections", "listCollections"), {} as never)) as {
        _id: string;
        isOwner: boolean;
        name: string;
        shared: boolean;
    }[];

const newFile = async (userId: string, extra: Record<string, unknown> = {}): Promise<string> =>
    await run(
        async (context) =>
            await context.db.insert("knowledgeFiles", { createdAt: 0, mimeType: "text/plain", name: "f.txt", size: 1, status: "indexed", userId, ...extra }),
    );

beforeEach(() => {
    harness = lunoraTest(schemaWithShardedTables(["knowledgeCollections", "projects"]) as never);
});

afterEach(() => {
    harness.close();
});

describe("collection CRUD and ownership", () => {
    it("lists the caller's collections and those shared with their organization, nothing else", async () => {
        await create(OWNER, "Handbook", true);
        await create(OWNER, "Private notes");
        await create(STRANGER, "Stranger's");

        const [ownerRows, mateRows, strangerRows] = await Promise.all([list(OWNER), list(MATE), list(STRANGER)]);

        expect(ownerRows.map((row) => [row.name, row.isOwner, row.shared])).toEqual([
            ["Handbook", true, true],
            ["Private notes", true, false],
        ]);
        expect(mateRows.map((row) => [row.name, row.isOwner, row.shared])).toEqual([["Handbook", false, true]]);
        expect(strangerRows.map((row) => row.name)).toEqual(["Stranger's"]);
    });

    it("validates names and refuses sharing outside an organization", async () => {
        await expect(create(OWNER, " ".repeat(3))).rejects.toThrow();
        await expect(create(OWNER, "x".repeat(81))).rejects.toThrow();
        await expect(create(STRANGER, "Shared", true)).rejects.toThrow("organization");
    });

    it("lets only the owner update, unshare or delete — a member cannot", async () => {
        const id = await create(OWNER, "Handbook", true);

        await expect(
            as(MATE).mutation(procedureAt("knowledge_collections", "updateCollection"), { collectionId: id, name: "Mine now" } as never),
        ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
        await expect(as(MATE).mutation(procedureAt("knowledge_collections", "deleteCollection"), { collectionId: id } as never)).rejects.toThrow();

        await as(OWNER).mutation(procedureAt("knowledge_collections", "updateCollection"), {
            collectionId: id,
            name: "Handbook v2",
            shareWithOrganization: false,
        } as never);

        expect(await list(MATE)).toEqual([]);
        const [renamed] = await list(OWNER);

        expect(renamed).toMatchObject({ name: "Handbook v2", shared: false });
    });

    it("deleting keeps the files as uncategorised, or removes them with deleteFiles", async () => {
        const keep = await create(OWNER, "Keep");
        const drop = await create(OWNER, "Drop");
        const kept = await newFile(OWNER, { collectionId: keep });
        const dropped = await newFile(OWNER, { collectionId: drop });

        await expect(as(OWNER).mutation(procedureAt("knowledge_collections", "deleteCollection"), { collectionId: keep } as never)).resolves.toEqual({
            filesDeleted: 0,
            filesUnfiled: 1,
        });
        await expect(
            as(OWNER).mutation(procedureAt("knowledge_collections", "deleteCollection"), { collectionId: drop, deleteFiles: true } as never),
        ).resolves.toEqual({
            filesDeleted: 1,
            filesUnfiled: 0,
        });

        // The dropped file is only MARKED: gone from the user's list at once,
        // removed with its chunks by the background drain.
        const listed = (await as(OWNER).query(procedureAt("knowledge_functions", "listFiles"), {} as never)) as { _id: string }[];

        expect(listed.map((file) => file._id)).toEqual([kept]);
        const marked = await run(async (context) => await context.db.get(dropped));

        expect(marked.status).toBe("deleting");

        await run(async (context) => await context.runMutation(procedureAt("knowledge_housekeeping", "drainDeletingFiles"), {}));

        const [keptRow, droppedRow] = await run(async (context) => [await context.db.get(kept), await context.db.get(dropped)]);

        expect(keptRow).not.toBeNull();
        expect(keptRow.collectionId).toBeUndefined();
        expect(droppedRow).toBeNull();
        expect(await list(OWNER)).toEqual([]);
    });
});

describe("filing files", () => {
    it("files the caller's own files into the caller's own collection, and back out", async () => {
        const collectionId = await create(OWNER, "Docs");
        const fileId = await newFile(OWNER);

        await as(OWNER).mutation(procedureAt("knowledge_collections", "setFileCollection"), { collectionId, fileIds: [fileId] } as never);
        const filed = await run(async (context) => await context.db.get(fileId));

        expect(filed.collectionId).toBe(collectionId);

        await as(OWNER).mutation(procedureAt("knowledge_collections", "setFileCollection"), { fileIds: [fileId] } as never);
        const unfiled = await run(async (context) => await context.db.get(fileId));

        expect(unfiled.collectionId).toBeUndefined();
    });

    it("refuses someone else's file, and a collection the caller does not own even when shared with them", async () => {
        const shared = await create(OWNER, "Shared", true);
        const mine = await create(MATE, "Mine");
        const ownersFile = await newFile(OWNER);
        const matesFile = await newFile(MATE);

        await expect(
            as(MATE).mutation(procedureAt("knowledge_collections", "setFileCollection"), { collectionId: mine, fileIds: [ownersFile] } as never),
        ).rejects.toThrow();
        await expect(
            as(MATE).mutation(procedureAt("knowledge_collections", "setFileCollection"), { collectionId: shared, fileIds: [matesFile] } as never),
        ).rejects.toThrow();
        await expect(
            as(MATE).mutation(procedureAt("knowledge_functions", "addFile"), {
                collectionId: shared,
                mimeType: "text/plain",
                name: "x",
                size: 1,
                vaultFileId: "nope",
            } as never),
        ).rejects.toThrow();
    });
});

describe("attaching collections", () => {
    const newThread = async (userId: string, extra: Record<string, unknown> = {}): Promise<string> =>
        await run(async (context) => await context.db.insert("threads", { status: "active", title: "t", userId, ...extra }));

    it("attaches the owner's own and org-shared collections to their thread; never a private one or someone else's thread", async () => {
        const shared = await create(OWNER, "Shared", true);
        const privateOne = await create(OWNER, "Private");
        const own = await create(MATE, "Own");
        const thread = await newThread(MATE);
        const ownersThread = await newThread(OWNER);
        const attach = async (userId: string, collectionId: string, threadId: string) =>
            await as(userId).mutation(procedureAt("knowledge_collections", "attachCollectionToThread"), { collectionId, threadId } as never);

        await expect(attach(MATE, own, thread)).resolves.toEqual({ alreadyAttached: false });
        await expect(attach(MATE, shared, thread)).resolves.toEqual({ alreadyAttached: false });
        await expect(attach(MATE, shared, thread)).resolves.toEqual({ alreadyAttached: true });
        await expect(attach(MATE, privateOne, thread)).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
        await expect(attach(MATE, own, ownersThread)).rejects.toThrow();

        const attached = (await as(MATE).query(procedureAt("knowledge_collections", "getThreadCollections"), { threadId: thread } as never)) as {
            name: string;
        }[];

        expect(attached.map((row) => row.name).toSorted((a, b) => a.localeCompare(b))).toEqual(["Own", "Shared"]);
        await expect(as(STRANGER).query(procedureAt("knowledge_collections", "getThreadCollections"), { threadId: thread } as never)).rejects.toThrow();

        await as(MATE).mutation(procedureAt("knowledge_collections", "detachCollectionFromThread"), { collectionId: shared, threadId: thread } as never);
        expect(await as(MATE).query(procedureAt("knowledge_collections", "getThreadCollections"), { threadId: thread } as never)).toHaveLength(1);
    });

    it("attaches to a project only for its owner", async () => {
        const collectionId = await create(OWNER, "Docs");
        const projectId = await run(async (context) => await context.db.insert("projects", { createdAt: 0, title: "P", updatedAt: 0, userId: OWNER }));

        await as(OWNER).mutation(procedureAt("knowledge_collections", "attachCollectionToProject"), { collectionId, projectId } as never);
        expect(await as(OWNER).query(procedureAt("knowledge_collections", "getProjectCollections"), { projectId } as never)).toMatchObject([{ name: "Docs" }]);
        await expect(as(STRANGER).query(procedureAt("knowledge_collections", "getProjectCollections"), { projectId } as never)).rejects.toThrow();
        await expect(
            as(MATE).mutation(procedureAt("knowledge_collections", "attachCollectionToProject"), { collectionId, projectId } as never),
        ).rejects.toThrow();
    });
});

describe("reading and searching a collection", () => {
    it("lists a shared collection's files for an organization member, not for a stranger", async () => {
        const shared = await create(OWNER, "Shared", true);

        await newFile(OWNER, { collectionId: shared, name: "policy.md", relativePath: "handbook/policy.md" });

        const files = (await as(MATE).action(procedureAt("knowledge_collections", "listCollectionFiles"), { collectionId: shared } as never)) as {
            name: string;
        }[];

        expect(files).toMatchObject([{ name: "policy.md", relativePath: "handbook/policy.md" }]);
        await expect(as(STRANGER).action(procedureAt("knowledge_collections", "listCollectionFiles"), { collectionId: shared } as never)).rejects.toThrow(
            expect.objectContaining({ code: "NOT_FOUND" }),
        );
    });

    it("resolves a thread's scope: linked files, own collections to indexed files, shared ones per owner", async () => {
        const own = await create(MATE, "Own");
        const shared = await create(OWNER, "Shared", true);
        const privateOne = await create(OWNER, "Private");
        const indexed = await newFile(MATE, { collectionId: own });

        await newFile(MATE, { collectionId: own, status: "pending" });

        const linked = await newFile(MATE);
        const thread = await run(async (context) => {
            const threadId = await context.db.insert("threads", { status: "active", title: "t", userId: MATE });

            await context.db.insert("threadKnowledge", { addedAt: 0, knowledgeFileId: linked, threadId });

            for (const collectionId of [own, shared, privateOne]) {
                await context.db.insert("knowledgeCollectionLinks", { addedAt: 0, collectionId, threadId, userId: MATE });
            }

            return threadId;
        });
        const { resolveRetrievalScope } = await import("./collections");
        const scope = await run(async (context) => await context.runQuery(resolveRetrievalScope, { threadId: thread, userId: MATE }));

        expect(scope).toEqual({ fileIds: [linked, indexed], foreign: [{ collectionIds: [shared], ownerId: OWNER }], hasExplicitScope: true });
    });

    it("a shared collection's files resolve on the owner's side only for a member", async () => {
        const shared = await create(OWNER, "Shared", true);
        const file = await newFile(OWNER, { collectionId: shared });
        const { resolveSharedCollectionFiles } = await import("./collections");
        const resolve = async (requesterId: string, ownerId = OWNER) =>
            await run(async (context) => await context.runQuery(resolveSharedCollectionFiles, { collectionIds: [shared], ownerId, requesterId }));

        expect(await resolve(MATE)).toEqual([file]);
        expect(await resolve(STRANGER)).toEqual([]);
        // A caller naming the wrong owner gets nothing either.
        expect(await resolve(MATE, MATE)).toEqual([]);
    });
});

describe("adding a URL", () => {
    it("accepts a public page into the caller's collection and refuses private addresses", async () => {
        const collectionId = await create(OWNER, "Web");
        const id = await as(OWNER).mutation(procedureAt("knowledge_documents", "addUrl"), { collectionId, url: "https://example.com/docs#top" } as never);
        const row = await run(async (context) => await context.db.get(id));

        expect(row).toMatchObject({ collectionId, name: "example.com/docs", sourceUrl: "https://example.com/docs", userId: OWNER });

        for (const url of ["http://169.254.169.254/latest", "http://localhost:8788/", "ftp://example.com/x"]) {
            await expect(as(OWNER).mutation(procedureAt("knowledge_documents", "addUrl"), { url } as never)).rejects.toThrow();
        }

        await expect(
            as(STRANGER).mutation(procedureAt("knowledge_documents", "addUrl"), { collectionId, url: "https://example.com" } as never),
        ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    });
});
