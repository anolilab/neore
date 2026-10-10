/**
 * Regression pins for the authorization audit (`docs/security/authz-matrix.md`).
 *
 * Each client-reachable procedure's own check is the primary control; row-level
 * security (`lib/rls/`) sits underneath as defence in depth, and these cases run
 * with it on. Every case here is a hole that existed: the stranger is denied (or
 * sees nothing), and the owner still gets through — the second half is what
 * stops a "fix" that simply breaks the feature from passing.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi } from "../test/registered-api";

import { signDocsForDisplay } from "./agent/display-media";
import { toStorageRef } from "./lib/storage-ref";
import { schemaWithShardedTables } from "./lib/test-schema";

/**
 * `api.*` / `internal.*` references, resolved against the real modules loaded in
 * `beforeAll` (the harness only runs a reference it was handed as a function).
 * Loading them there, after the mocks, also keeps the agent modules' import
 * cycle in the order the app itself evaluates it.
 */
const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("./_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("./_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

const MODULES = {
    agent_branches: async () => await import("./agent/branches"),
    agent_files: async () => await import("./agent/files"),
    agent_messages: async () => await import("./agent/messages"),
    agent_projects: async () => await import("./agent/projects"),
    agent_streams: async () => await import("./agent/streams"),
    agent_threads: async () => await import("./agent/threads"),
    auth_billing: async () => await import("./auth/billing"),
    chat_functions: async () => await import("./chat/functions"),
    chat_import_functions: async () => await import("./chat-import/functions"),
    chat_sharing: async () => await import("./chat/sharing"),
    chat_slides_functions: async () => await import("./chat/slides/functions"),
    chat_streaming: async () => await import("./chat/streaming"),
    chat_streaming_persistent_library: async () => await import("./chat/streaming/persistent/library"),
    crons: async () => await import("./crons"),
    knowledge_functions: async () => await import("./knowledge/functions"),
    pages_functions: async () => await import("./pages/functions"),
    pages_sharing: async () => await import("./pages/sharing"),
    projects_functions: async () => await import("./projects/functions"),
    prompts_functions: async () => await import("./prompts/functions"),
    vault_functions: async () => await import("./vault/functions"),
    workflow_functions: async () => await import("./workflow/functions"),
    workflow_gallery: async () => await import("./workflow/gallery"),
    workflow_fork: async () => await import("./workflow/fork"),
} as const;

/** A procedure by its generated path, e.g. `procedureAt("chat_functions", "getChildThreads")`. */
const procedureAt = (module: keyof typeof MODULES, name: string): never => {
    const procedure = registry.get(`${module}:${name}`);

    if (!procedure) {
        throw new Error(`authz-regressions: ${module}.${name} is not exported`);
    }

    return procedure as never;
};

// Cold-loads most of the backend's module graph: ~2s here, past the 10s default on the Windows runner.
beforeAll(async () => {
    for (const [module, load] of Object.entries(MODULES)) {
        const exports = await load();

        for (const [name, value] of Object.entries(exports)) {
            registry.set(`${module}:${name}`, value);
        }
    }
}, 60_000);

const ADMIN_ERROR = /admin/iu;
const QUOTA_ERROR = /limited/iu;
const UUID_SHAPE = /^[0-9a-f-]{36}$/u;
const OWNER = "user-owner";
const GRANTEE = "user-grantee";
const STRANGER = "user-stranger";
const ORG = "org-owner";
const OTHER_ORG = "org-other";

/** Active organization per user — `ctx.user.activeOrganization` is a proven membership. */
const ACTIVE_ORG: Record<string, string> = { [OWNER]: ORG, [STRANGER]: ORG };
/** Membership rows, read through the (mocked) better-auth helper: the harness cannot hold `.global()` tables. */
const MEMBERS: Record<string, string[]> = { [ORG]: [OWNER, STRANGER] };

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) => {
            const { userId } = context.auth;

            if (!userId) {
                return null;
            }

            const org = ({ "user-owner": "org-owner", "user-stranger": "org-owner" } as Record<string, string>)[userId];

            return {
                activeOrganization: org ? { id: org, name: org, role: "member", slug: org } : null,
                email: `${userId}@example.com`,
                id: userId,
                isAdmin: false,
                name: userId,
                userId,
            };
        },
    };
});

vi.mock("./lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("./lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
        getSessionUserWithAnonymous: sessionFrom,
    };
});

vi.mock("./auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("./auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

vi.mock("./auth/lib/better-auth-queries", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("./auth/lib/better-auth-queries")>()),
        getMemberByOrganizationAndUser: async (_context: unknown, organizationId: string, userId: string) =>
            (MEMBERS[organizationId] ?? []).includes(userId) ? { organizationId, role: "member", userId } : null,
    };
});

vi.mock("./lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("./lib/rate-limiter")>()),
        rateLimitGuard: async () => undefined,
    };
});

// `files` is audited, and its trigger writes the `.global()` `documentHistory`
// table the harness cannot store. Auditing is not what is under test.
vi.mock("./lib/audit-triggers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("./lib/audit-triggers")>()),
        auditTriggersFor: () => {
            return {};
        },
    };
});

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

const as = (userId: string) => harness.withIdentity({ userId } as never);
const run = async <T>(body: (context: any) => Promise<T>): Promise<T> => await harness.run(body);

const newThread = async (userId: string, extra: Record<string, unknown> = {}): Promise<string> =>
    await run(async (context) => await context.db.insert("threads", { status: "active", title: "t", userId, ...extra }));

beforeEach(() => {
    // The `.global()` tables these tests seed; the harness has no D1 backend (see lib/test-schema.ts).
    harness = lunoraTest(schemaWithShardedTables(["projects", "prompts", "promptHistory", "userVariableDefaults"]) as never);
});

afterEach(() => {
    harness.close();
});

describe("thread relationships", () => {
    it("createThreadRelationshipPublic refuses a stranger's thread on either end, and links the caller's own", async () => {
        const victim = await newThread(OWNER);
        const mine = await newThread(STRANGER);
        const mineToo = await newThread(STRANGER);

        await expect(
            as(STRANGER).mutation(procedureAt("chat_functions", "createThreadRelationshipPublic"), { parentThreadId: victim, threadId: mine } as never),
        ).rejects.toThrow();
        await expect(
            as(STRANGER).mutation(procedureAt("chat_functions", "createThreadRelationshipPublic"), { parentThreadId: mine, threadId: victim } as never),
        ).rejects.toThrow();

        await as(STRANGER).mutation(procedureAt("chat_functions", "createThreadRelationshipPublic"), { parentThreadId: mine, threadId: mineToo } as never);

        expect(await run(async (context) => await context.db.query("threadRelationships").collect())).toHaveLength(1);
    });

    it("getChildThreads leaves out a child the caller does not own, even when a relationship row names it", async () => {
        const mine = await newThread(STRANGER);
        const victim = await newThread(OWNER, { customSystemPrompt: "secret" });
        const ownChild = await newThread(STRANGER);

        await run(async (context) => {
            // Carrying the caller's id, as `createThreadRelationship` would write them.
            await context.db.insert("threadRelationships", { createdAt: 0, parentThreadId: mine, threadId: victim, userId: STRANGER });
            await context.db.insert("threadRelationships", { createdAt: 0, parentThreadId: mine, threadId: ownChild, userId: STRANGER });
        });

        const children = (await as(STRANGER).query(procedureAt("chat_functions", "getChildThreads"), { parentThreadId: mine } as never)) as { _id: string }[];

        expect(children.map((child) => child._id)).toEqual([ownChild]);
    });
});

describe("thread sharing", () => {
    const seedShared = async () => {
        const threadId = await newThread(OWNER, { isPublic: true });

        await run(async (context) => {
            await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "read", threadId, userId: GRANTEE });
            await context.db.insert("threadInvites", {
                expiresAt: Date.now() + 60_000,
                invitedBy: OWNER,
                invitedEmail: "x@example.com",
                inviteToken: "admin-bearer-token",
                permission: "admin",
                status: "pending",
                threadId,
            });
        });

        return threadId;
    };

    it("getThreadInvites (bearer tokens) is admin-only: a read grantee and a public-thread stranger are refused", async () => {
        const threadId = await seedShared();

        await expect(as(GRANTEE).query(procedureAt("chat_sharing", "getThreadInvites"), { threadId } as never)).rejects.toThrow();
        await expect(as(STRANGER).query(procedureAt("chat_sharing", "getThreadInvites"), { threadId } as never)).rejects.toThrow();
        expect(await as(OWNER).query(procedureAt("chat_sharing", "getThreadInvites"), { threadId } as never)).toHaveLength(1);
    });

    it("getThreadAccess hides grantee e-mails from a non-admin grantee", async () => {
        const threadId = await seedShared();
        const grantee = (await as(GRANTEE).query(procedureAt("chat_sharing", "getThreadAccess"), { threadId } as never)) as { users: { email: string }[] };

        expect(grantee.users).toHaveLength(1);
        expect(grantee.users.every((user) => user.email === "")).toBe(true);
    });
});

describe("slides", () => {
    const seedDeck = async () =>
        await run(async (context) => {
            const threadId = await context.db.insert("threads", { status: "active", userId: OWNER });
            const presentationId = await context.db.insert("presentations", {
                createdAt: 0,
                name: "deck",
                status: "generating",
                threadId,
                title: "Deck",
                updatedAt: 0,
                userId: OWNER,
            });
            const slideId = await context.db.insert("presentationSlides", {
                createdAt: 0,
                htmlContent: "<p>1</p>",
                presentationId,
                slideNumber: 1,
                title: "1",
                updatedAt: 0,
            });

            return { presentationId, slideId, threadId };
        });

    it("a stranger can neither read nor change another user's deck; the owner can", async () => {
        const { presentationId, slideId, threadId } = await seedDeck();

        await expect(as(STRANGER).query(procedureAt("chat_slides_functions", "getPresentation"), { presentationId } as never)).rejects.toThrow();
        await expect(as(STRANGER).query(procedureAt("chat_slides_functions", "getPresentationSlides"), { presentationId } as never)).rejects.toThrow();
        expect(await as(STRANGER).query(procedureAt("chat_slides_functions", "getGeneratingPresentation"), { threadId } as never)).toBeNull();
        await expect(as(STRANGER).mutation(procedureAt("chat_slides_functions", "updateSlide"), { htmlContent: "pwned", slideId } as never)).rejects.toThrow();
        await expect(as(STRANGER).mutation(procedureAt("chat_slides_functions", "deletePresentation"), { presentationId } as never)).rejects.toThrow();

        expect(await as(OWNER).query(procedureAt("chat_slides_functions", "getPresentation"), { presentationId } as never)).toMatchObject({ userId: OWNER });
        expect(await as(OWNER).query(procedureAt("chat_slides_functions", "getPresentationSlides"), { presentationId } as never)).toHaveLength(1);
        expect(await as(OWNER).query(procedureAt("chat_slides_functions", "getGeneratingPresentation"), { threadId } as never)).toMatchObject({
            _id: presentationId,
        });
        await as(OWNER).mutation(procedureAt("chat_slides_functions", "updateSlide"), { htmlContent: "<p>edited</p>", slideId } as never);
        expect(await run(async (context) => ((await context.db.get(slideId)) as { htmlContent: string }).htmlContent)).toBe("<p>edited</p>");
    });
});

describe("chat import", () => {
    it("startImportJob only ever names an upload under the caller's own staging prefix", async () => {
        await expect(
            as(STRANGER).mutation(procedureAt("chat_import_functions", "startImportJob"), {
                provider: "chatgpt",
                totalConversations: 1,
                uploadId: `../${OWNER}/V1StGXR8_Z5jdHi6B-myT`,
            } as never),
        ).rejects.toThrow();

        const { jobId } = (await as(STRANGER).mutation(procedureAt("chat_import_functions", "startImportJob"), {
            provider: "chatgpt",
            totalConversations: 1,
            uploadId: "V1StGXR8_Z5jdHi6B-myT",
        } as never)) as { jobId: string };

        expect(await run(async (context) => ((await context.db.get(jobId as never)) as { r2Key: string }).r2Key)).toBe(
            `uploads/${STRANGER}/V1StGXR8_Z5jdHi6B-myT`,
        );
    });
});

describe("projects and organizations", () => {
    const seedOrgProject = async () =>
        await run(
            async (context) =>
                await context.db.insert("projects", { context: "org secret", createdAt: 0, organizationId: OTHER_ORG, title: "p", userId: "someone" }),
        );

    it("agent_projects.listProjects by organization requires membership", async () => {
        await seedOrgProject();
        MEMBERS[OTHER_ORG] = ["someone"];

        const stranger = (await as(STRANGER).query(procedureAt("agent_projects", "listProjects"), { organizationId: OTHER_ORG } as never)) as {
            page: unknown[];
        };

        expect(stranger.page).toEqual([]);

        MEMBERS[OTHER_ORG] = ["someone", STRANGER];

        const member = (await as(STRANGER).query(procedureAt("agent_projects", "listProjects"), { organizationId: OTHER_ORG } as never)) as { page: unknown[] };

        expect(member.page).toHaveLength(1);
        delete MEMBERS[OTHER_ORG];
    });

    it("createProject and createWorkflow refuse an organization that is not the caller's active one", async () => {
        await expect(
            as(STRANGER).mutation(procedureAt("projects_functions", "createProject"), { organizationId: OTHER_ORG, title: "planted" } as never),
        ).rejects.toThrow();
        await expect(
            as(STRANGER).mutation(procedureAt("workflow_functions", "createWorkflow"), { organizationId: OTHER_ORG, title: "planted" } as never),
        ).rejects.toThrow();

        await expect(
            as(OWNER).mutation(procedureAt("projects_functions", "createProject"), { organizationId: ACTIVE_ORG[OWNER], title: "mine" } as never),
        ).resolves.toEqual(expect.any(String));
        await expect(as(OWNER).mutation(procedureAt("workflow_functions", "createWorkflow"), { title: "mine" } as never)).resolves.toEqual(expect.any(String));
    });

    it("deleteProject will not move the caller's threads into someone else's project", async () => {
        const victimProject = await run(async (context) => await context.db.insert("projects", { createdAt: 0, title: "victim", userId: OWNER }));
        const ownProject = await run(async (context) => await context.db.insert("projects", { createdAt: 0, title: "mine", userId: STRANGER }));

        await expect(
            as(STRANGER).mutation(procedureAt("projects_functions", "deleteProject"), {
                moveThreadsToProjectId: victimProject,
                projectId: ownProject,
            } as never),
        ).rejects.toThrow();
        expect(await run(async (context) => await context.db.get(ownProject))).not.toBeNull();
    });
});

describe("thread-scoped rows keyed by an argument thread id", () => {
    it("thread variables cannot be planted in, or read from, another user's thread", async () => {
        const victim = await newThread(OWNER);

        await expect(
            as(STRANGER).mutation(procedureAt("prompts_functions", "setThreadVariables"), {
                threadId: victim,
                variables: [{ name: "x", value: "planted" }],
            } as never),
        ).rejects.toThrow();
        await expect(
            as(STRANGER).mutation(procedureAt("prompts_functions", "updateThreadVariable"), { name: "x", threadId: victim, value: "planted" } as never),
        ).rejects.toThrow();

        await as(OWNER).mutation(procedureAt("prompts_functions", "setThreadVariables"), {
            threadId: victim,
            variables: [{ name: "secret", value: "owner-value" }],
        } as never);

        const stranger = (await as(STRANGER).query(procedureAt("prompts_functions", "getResolvedVariables"), { threadId: victim } as never)) as {
            values: Record<string, string>;
        };
        const owner = (await as(OWNER).query(procedureAt("prompts_functions", "getResolvedVariables"), { threadId: victim } as never)) as {
            values: Record<string, string>;
        };

        expect(stranger.values).not.toHaveProperty("secret");
        expect(owner.values).toMatchObject({ secret: "owner-value" });
    });

    it("thread knowledge links are the thread owner's alone", async () => {
        const victim = await newThread(OWNER);
        const [ownerFile, strangerFile] = await run(async (context) => [
            await context.db.insert("knowledgeFiles", {
                createdAt: 0,
                mimeType: "text/plain",
                name: "owner.txt",
                size: 1,
                status: "ready",
                summary: "private",
                userId: OWNER,
            }),
            await context.db.insert("knowledgeFiles", { createdAt: 0, mimeType: "text/plain", name: "mine.txt", size: 1, status: "ready", userId: STRANGER }),
        ]);

        await as(OWNER).mutation(procedureAt("knowledge_functions", "attachToThread"), { knowledgeFileId: ownerFile, threadId: victim } as never);

        await expect(
            as(STRANGER).mutation(procedureAt("knowledge_functions", "attachToThread"), { knowledgeFileId: strangerFile, threadId: victim } as never),
        ).rejects.toThrow();
        await expect(
            as(STRANGER).mutation(procedureAt("knowledge_functions", "detachFromThread"), { knowledgeFileId: ownerFile, threadId: victim } as never),
        ).rejects.toThrow();
        await expect(as(STRANGER).query(procedureAt("knowledge_functions", "getThreadKnowledge"), { threadId: victim } as never)).rejects.toThrow(
            expect.objectContaining({ code: "NOT_FOUND" }),
        );
        expect(await as(OWNER).query(procedureAt("knowledge_functions", "getThreadKnowledge"), { threadId: victim } as never)).toMatchObject([
            { name: "owner.txt" },
        ]);

        // A shared READER sees the thread's knowledge, but still cannot change it.
        await run(async (context) => {
            await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "read", threadId: victim, userId: GRANTEE });
        });

        expect(await as(GRANTEE).query(procedureAt("knowledge_functions", "getThreadKnowledge"), { threadId: victim } as never)).toMatchObject([
            { name: "owner.txt" },
        ]);
        await expect(
            as(GRANTEE).mutation(procedureAt("knowledge_functions", "detachFromThread"), { knowledgeFileId: ownerFile, threadId: victim } as never),
        ).rejects.toThrow();
    });
});

describe("streams", () => {
    const seedStream = async (threadExtra: Record<string, unknown>) => {
        const threadId = await newThread(OWNER, threadExtra);

        const streamId = await run(async (context) => {
            await context.db.insert("streamingMessages", {
                order: 0,
                state: { kind: "streaming", lastHeartbeat: Date.now() },
                stateKind: "streaming",
                stepOrder: 0,
                threadId,
                userId: OWNER,
            });

            return await context.db.insert("persistentStreams", {
                expiresAt: Date.now() + 60_000,
                messageId: "m",
                status: "streaming",
                streamingConfig: { contentType: "text", model: "m" },
                threadId,
                userId: OWNER,
            });
        });

        return { streamId, threadId };
    };

    it("agent_streams.list gives raw rows to the owner only — isPublic grants nothing", async () => {
        const { threadId } = await seedStream({ isPublic: true });

        expect(await as(STRANGER).query(procedureAt("agent_streams", "list"), { threadId } as never)).toEqual([]);
        // The owner gets PAST the check. (In this harness the rows then trip the output
        // validator: `agent/streams` sits in an import cycle that leaves
        // `vStreamMessage` unbound when it is evaluated outside the app's own
        // module order — so "not the denial's []" is what is asserted here.)
        const owner = await as(OWNER)
            .query(procedureAt("agent_streams", "list"), { threadId } as never)
            .catch((error: unknown) => error);

        expect(owner).not.toEqual([]);
    });

    it("getStreamBody and getActiveStreamForThread refuse a stranger on a private thread", async () => {
        const { streamId, threadId } = await seedStream({});

        await expect(as(STRANGER).query(procedureAt("chat_streaming", "getStreamBody"), { streamId } as never)).rejects.toThrow();
        expect(await as(STRANGER).query(procedureAt("chat_streaming", "getActiveStreamForThread"), { threadId } as never)).toBeNull();

        expect(await as(OWNER).query(procedureAt("chat_streaming", "getActiveStreamForThread"), { threadId } as never)).toEqual({ streamId });
        await expect(as(OWNER).query(procedureAt("chat_streaming", "getStreamBody"), { streamId } as never)).resolves.toMatchObject({ status: "streaming" });
    });

    it("a public thread's viewer gets the stream text but not its reasoning", async () => {
        const { streamId } = await seedStream({ isPublic: true });

        await run(async (context) => {
            await context.db.insert("persistentChunks", { reasoning: "private chain of thought", seq: 0, streamId, text: "hello" });
        });

        const viewer = (await as(STRANGER).query(procedureAt("chat_streaming", "getStreamBody"), { streamId } as never)) as { reasoning: string; text: string };
        const owner = (await as(OWNER).query(procedureAt("chat_streaming", "getStreamBody"), { streamId } as never)) as { reasoning: string; text: string };

        expect(viewer).toMatchObject({ reasoning: "", text: "hello" });
        expect(owner).toMatchObject({ reasoning: "private chain of thought", text: "hello" });
    });
});

describe("vault", () => {
    it("deleteAttachments deletes only the caller's own uploads, never another org member's", async () => {
        const threadId = await newThread(OWNER);
        const fileId = await run(
            async (context) =>
                await context.db.insert("files", {
                    chatId: threadId,
                    key: "owner-file",
                    name: "a.png",
                    organizationId: ORG,
                    size: 1,
                    type: "image/png",
                    userId: OWNER,
                }),
        );

        await as(STRANGER).mutation(procedureAt("vault_functions", "deleteAttachments"), { attachmentIds: [fileId] } as never);
        expect(await run(async (context) => await context.db.get(fileId))).not.toBeNull();

        await as(OWNER).mutation(procedureAt("vault_functions", "deleteAttachments"), { attachmentIds: [fileId] } as never);
        expect(await run(async (context) => await context.db.get(fileId))).toBeNull();
    });
});

describe("crons", () => {
    it("deleteExpiredTemporaryChats deletes an expired temporary chat (a cron has no caller identity)", async () => {
        const expired = await newThread(OWNER, { isTemporary: true });
        const live = await newThread(OWNER, { isTemporary: true });

        await run(async (context) => {
            await context.db.insert("temporaryThreads", { expiresAt: Date.now() - 1000, threadId: expired, userId: OWNER });
            await context.db.insert("temporaryThreads", { expiresAt: Date.now() + 60_000, threadId: live, userId: OWNER });
        });

        await run(async (context) => await context.runMutation(procedureAt("crons", "deleteExpiredTemporaryChats"), {}));

        expect(await run(async (context) => await context.db.get(expired))).toBeNull();
        expect(await run(async (context) => await context.db.get(live))).not.toBeNull();
        expect(await run(async (context) => await context.db.query("temporaryThreads").collect())).toHaveLength(1);
    });

    it("any thread delete takes the temporary-chat marker with it, not only the expiry cron", async () => {
        const threadId = await newThread(OWNER, { isTemporary: true });

        await run(async (context) => {
            await context.db.insert("temporaryThreads", { expiresAt: Date.now() + 60_000, threadId, userId: OWNER });
        });

        await run(async (context) => await context.runMutation(procedureAt("agent_threads", "deleteAllForThreadIdAsync"), { threadId }));

        expect(await run(async (context) => await context.db.get(threadId))).toBeNull();
        expect(await run(async (context) => await context.db.query("temporaryThreads").collect())).toHaveLength(0);
    });
});

describe("vault files are private to their owner", () => {
    const seedFile = async () => {
        const threadId = await newThread(OWNER);

        await run(async (context) => {
            await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "read", threadId, userId: GRANTEE });
        });

        const fileId = await run(
            async (context) =>
                await context.db.insert("files", {
                    chatId: threadId,
                    key: "owner-file",
                    name: "a.png",
                    organizationId: ORG,
                    size: 1,
                    type: "image/png",
                    userId: OWNER,
                }),
        );

        return { fileId, threadId };
    };

    it("an org member gets nothing of another member's file; the owner and a chat grantee do", async () => {
        const { fileId } = await seedFile();

        await expect(as(STRANGER).query(procedureAt("vault_functions", "getAttachment"), { attachmentId: fileId } as never)).rejects.toThrow();
        await expect(as(STRANGER).query(procedureAt("vault_functions", "getStorageUrl"), { key: "owner-file" } as never)).rejects.toThrow();
        expect(await as(STRANGER).query(procedureAt("vault_functions", "findAttachmentByKey"), { key: "owner-file" } as never)).toBeNull();
        expect(await as(STRANGER).query(procedureAt("vault_functions", "getAttachmentsForUser"), {} as never)).toEqual([]);
        expect(await as(STRANGER).query(procedureAt("vault_functions", "getAttachmentsForOrganization"), {} as never)).toEqual([]);

        expect(await as(OWNER).query(procedureAt("vault_functions", "getAttachment"), { attachmentId: fileId } as never)).toMatchObject({ _id: fileId });
        expect(await as(OWNER).query(procedureAt("vault_functions", "getAttachmentsForUser"), {} as never)).toHaveLength(1);
        expect(await as(GRANTEE).query(procedureAt("vault_functions", "getAttachment"), { attachmentId: fileId } as never)).toMatchObject({ _id: fileId });
    });
});

describe("public projects are served as a projection only", () => {
    const seedPublicWorkflow = async () =>
        await run(
            async (context) =>
                await context.db.insert("projects", {
                    context: "private project context",
                    createdAt: 0,
                    forkedFromId: "some-private-project",
                    galleryPublishedAt: 1,
                    isPublic: true,
                    organizationId: ORG,
                    projectType: "workflow",
                    publicAccessToken: "wf-token",
                    title: "Public flow",
                    userId: OWNER,
                    workflowContent: { edges: [], nodes: [] },
                }),
        );

    it("agent_projects.getProject no longer returns a public project's full row to a non-owner", async () => {
        const projectId = await seedPublicWorkflow();

        expect(await as(STRANGER).query(procedureAt("agent_projects", "getProject"), { projectId } as never)).toBeNull();
        expect(await as(OWNER).query(procedureAt("agent_projects", "getProject"), { projectId } as never)).toMatchObject({
            context: "private project context",
        });
    });

    it("the gallery reads carry no owner id, org id, context or fork lineage", async () => {
        await seedPublicWorkflow();

        const shared = (await as(STRANGER).action(procedureAt("workflow_gallery", "getPublicWorkflow"), { publicAccessToken: "wf-token" } as never)) as Record<
            string,
            unknown
        >;
        const browsed = (await as(STRANGER).query(procedureAt("workflow_gallery", "browseGallery"), {} as never)) as { page: Record<string, unknown>[] };

        for (const item of [shared, ...browsed.page]) {
            expect(item).toMatchObject({ title: "Public flow" });
            expect(item).not.toHaveProperty("userId");
            expect(item).not.toHaveProperty("organizationId");
            expect(item).not.toHaveProperty("context");
            expect(item).not.toHaveProperty("forkedFromId");
        }
    });
});

describe("billing tier is a platform-admin operation", () => {
    it("a non-admin cannot set an organization's tier or a member's credit override", async () => {
        await expect(
            as(OWNER).mutation(procedureAt("auth_billing", "setOrganizationBillingTier"), { baseTier: "enterprise", organizationId: ORG } as never),
        ).rejects.toThrow(ADMIN_ERROR);
        await expect(
            as(OWNER).mutation(procedureAt("auth_billing", "setMemberCreditOverride"), {
                creditOverride: 1_000_000,
                organizationId: ORG,
                userId: OWNER,
            } as never),
        ).rejects.toThrow(ADMIN_ERROR);
    });
});

describe("remaining low findings", () => {
    it("updateThreadVisibility mints the share token itself; a caller-chosen one is ignored", async () => {
        const threadId = await newThread(OWNER);

        await as(OWNER).mutation(procedureAt("chat_functions", "updateThreadVisibility"), { isPublic: true, publicAccessToken: "chosen", threadId } as never);

        const token = await run(async (context) => ((await context.db.get(threadId)) as { publicAccessToken?: string }).publicAccessToken);

        expect(token).toMatch(UUID_SHAPE);
    });

    it("duplicatePrompt counts against the free prompt quota like createPrompt", async () => {
        const promptIds = await run(async (context) => {
            const ids: string[] = [];

            for (const name of ["a", "b", "c"]) {
                ids.push(await context.db.insert("prompts", { content: "x", currentVersion: 1, isFavorite: false, name, updatedAt: 0, userId: STRANGER }));
            }

            return ids;
        });

        await expect(as(STRANGER).mutation(procedureAt("prompts_functions", "duplicatePrompt"), { promptId: promptIds[0] } as never)).rejects.toThrow(
            QUOTA_ERROR,
        );
    });

    it("a page invite dies with its creator's admin grant", async () => {
        const { pageId } = (await as(OWNER).mutation(procedureAt("pages_functions", "createPage"), { title: "Page" } as never)) as { pageId: string };
        const invite = async (userId: string, permission: string) =>
            (
                (await as(userId).mutation(procedureAt("pages_sharing", "createPageInvite"), { expiresInDays: 7, pageId, permission } as never)) as {
                    token: string;
                }
            ).token;

        await as(GRANTEE).action(procedureAt("pages_sharing", "acceptPageInvite"), { token: await invite(OWNER, "admin") } as never);

        const granteeInvite = await invite(GRANTEE, "write");

        await as(OWNER).mutation(procedureAt("pages_sharing", "removePageGrant"), { pageId, targetUserId: GRANTEE } as never);

        await expect(as(STRANGER).action(procedureAt("pages_sharing", "acceptPageInvite"), { token: granteeInvite } as never)).rejects.toThrow();

        // An invite from someone who still holds admin works.
        await expect(
            as(STRANGER).action(procedureAt("pages_sharing", "acceptPageInvite"), { token: await invite(OWNER, "read") } as never),
        ).resolves.toMatchObject({
            pageId,
        });
    });
});

describe("stored media survives the owner's legitimate copies", () => {
    const ORIGIN = "http://localhost:8788";
    const MINE = `agent-files/${"a".repeat(64)}`;
    const VICTIM = `agent-files/${"c".repeat(64)}`;
    const signer = { getSignedUrl: async (key: string) => `${ORIGIN}/${key}?sig=fresh` };

    beforeEach(() => {
        vi.stubEnv("PUBLIC_ORIGIN", ORIGIN);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    /** A content-addressed chat file, optionally granted to `owner`. */
    const seedChatFile = async (key: string, owner?: string): Promise<string> =>
        await run(async (context) => {
            const fileId = await context.db.insert("chatFiles", {
                hash: key.slice("agent-files/".length),
                lastTouchedAt: 0,
                mediaType: "image/png",
                refcount: 1,
                storageId: key,
            });

            if (owner) {
                await context.db.insert("chatFileAccess", { createdAt: 0, fileId, userId: owner });
            }

            return fileId;
        });

    const grantsOf = async (userId: string): Promise<string[]> =>
        await run(async (context) => {
            const grants = await context.db
                .query("chatFileAccess")
                .withIndex("by_userId", (q: any) => q.eq("userId", userId))
                .collect();

            const files = await Promise.all(grants.map(async (grant: { fileId: string }) => await context.db.get(grant.fileId)));

            return files.map((file: { storageId: string }) => file.storageId);
        });

    it("media generated for a thread is granted to the thread's owner as well as the runner", async () => {
        const threadId = await newThread(OWNER);
        const fileId = await seedChatFile(MINE, GRANTEE);

        await run(async (context) => await context.runMutation(procedureAt("agent_files", "grantThreadOwnerAccess"), { fileId, threadId }));
        // A workflow run passes a threadId that names no thread: nothing to grant, nothing thrown.
        await run(async (context) => await context.runMutation(procedureAt("agent_files", "grantThreadOwnerAccess"), { fileId, threadId: "workflow" }));

        expect(await grantsOf(OWNER)).toEqual([MINE]);
        expect(await grantsOf(GRANTEE)).toEqual([MINE]);
    });

    it("a forked thread's tool results still show the source owner's media, and still not a planted key", async () => {
        await seedChatFile(MINE, OWNER);
        await seedChatFile(VICTIM, STRANGER);
        const source = await newThread(OWNER);
        const fork = await newThread(OWNER);

        await run(async (context) => {
            await context.db.insert("messages", {
                message: {
                    content: [
                        {
                            output: { type: "json", value: { mine: toStorageRef(MINE), planted: toStorageRef(VICTIM) } },
                            toolCallId: "t1",
                            toolName: "generateImage",
                            type: "tool-result",
                        },
                    ],
                    role: "tool",
                },
                order: 0,
                status: "success",
                stepOrder: 0,
                threadId: source,
                tool: true,
                userId: OWNER,
            });
        });

        await run(
            async (context) =>
                await context.runMutation(procedureAt("agent_messages", "cloneMessageBatch"), {
                    paginationOpts: { cursor: null, numItems: 10 },
                    sourceThreadId: source,
                    targetThreadId: fork,
                }),
        );

        const read = await run(async (context) => {
            const rows = await context.db
                .query("messages")
                .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", fork))
                .collect();

            return (await signDocsForDisplay({ db: context.db, storage: signer } as never, rows)) as any[];
        });
        const [copy] = read;

        // The copy keeps its source row's owner, so ownership is checked against the author.
        expect(copy.userId).toBe(OWNER);
        expect(copy.message.content[0].output.value).toEqual({ mine: `${ORIGIN}/${MINE}?sig=fresh`, planted: "" });
    });

    it("forking a public workflow grants the author's own media to the forker — never a key the author planted", async () => {
        await seedChatFile(MINE, OWNER);
        await seedChatFile(VICTIM, GRANTEE);
        const sourceProjectId = await run(
            async (context) =>
                await context.db.insert("projects", {
                    createdAt: 0,
                    isPublic: true,
                    name: "W",
                    projectType: "workflow",
                    title: "W",
                    userId: OWNER,
                    workflowContent: {
                        edges: [],
                        nodes: [{ data: { imageUrl: toStorageRef(MINE), maskUrl: toStorageRef(VICTIM) }, id: "n1", position: { x: 0, y: 0 }, type: "image" }],
                    },
                }),
        );

        const { projectId } = (await as(STRANGER).action(procedureAt("workflow_fork", "forkWorkflow"), { sourceProjectId } as never)) as {
            projectId: string;
        };
        const forked = await run(async (context) => await context.db.get(projectId));

        expect(forked.workflowContent.nodes[0].data).toEqual({ imageUrl: toStorageRef(MINE), maskUrl: "" });
        expect(await grantsOf(STRANGER)).toEqual([MINE]);
    });

    it("forking a public workflow copies the author's own vault images to the forker — never a vault key the author planted", async () => {
        const AUTHOR_VAULT = "vault-author-image";
        const VICTIM_VAULT = "vault-victim-image";

        await run(async (context) => {
            await context.db.insert("files", { key: AUTHOR_VAULT, name: "cat.png", size: 42, type: "image/png", userId: OWNER });
            await context.db.insert("files", { key: VICTIM_VAULT, name: "private.png", size: 7, type: "image/png", userId: GRANTEE });
        });

        const sourceProjectId = await run(
            async (context) =>
                await context.db.insert("projects", {
                    createdAt: 0,
                    isPublic: true,
                    name: "W",
                    projectType: "workflow",
                    title: "W",
                    userId: OWNER,
                    workflowContent: {
                        edges: [],
                        nodes: [
                            {
                                data: { imageUrl: toStorageRef(AUTHOR_VAULT), maskUrl: toStorageRef(VICTIM_VAULT) },
                                id: "n1",
                                position: { x: 0, y: 0 },
                                type: "image",
                            },
                        ],
                    },
                }),
        );

        const { projectId } = (await as(STRANGER).action(procedureAt("workflow_fork", "forkWorkflow"), { sourceProjectId } as never)) as {
            projectId: string;
        };
        const { copies, forked, source } = await run(async (context) => {
            return {
                copies: await context.db
                    .query("files")
                    .withIndex("by_user_and_folder", (q: any) => q.eq("userId", STRANGER))
                    .collect(),
                forked: await context.db.get(projectId),
                source: await context.db.get(sourceProjectId),
            };
        });

        // One copy, of the author's own file, under a key of the forker's own.
        expect(copies).toHaveLength(1);
        expect(copies[0]).toMatchObject({ name: "cat.png", size: 42, type: "image/png", userId: STRANGER });
        expect(copies[0].key).not.toBe(AUTHOR_VAULT);
        // The fork points at the copy; the planted key stays blank.
        expect(forked.workflowContent.nodes[0].data).toEqual({ imageUrl: toStorageRef(copies[0].key), maskUrl: "" });
        // The author's graph is untouched.
        expect(source.workflowContent.nodes[0].data.imageUrl).toBe(toStorageRef(AUTHOR_VAULT));
    });

    it("a public workflow's fork count is its live forks: recounted on each fork, so a deleted fork is no longer counted", async () => {
        const sourceProjectId = await run(
            async (context) =>
                await context.db.insert("projects", {
                    createdAt: 0,
                    isPublic: true,
                    name: "W",
                    projectType: "workflow",
                    title: "W",
                    userId: OWNER,
                    workflowContent: { edges: [], nodes: [] },
                }),
        );
        const fork = async () =>
            ((await as(STRANGER).action(procedureAt("workflow_fork", "forkWorkflow"), { sourceProjectId } as never)) as { projectId: string })
                .projectId;
        const countOf = async () => (await run(async (context) => await context.db.get(sourceProjectId))).galleryForkCount;

        const first = await fork();
        await fork();
        expect(await countOf()).toBe(2);

        await run(async (context) => await context.db.delete(first as never));
        await fork();
        expect(await countOf()).toBe(2);
    });
});
