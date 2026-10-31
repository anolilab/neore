/**
 * `answerSecretRequest` as a client calls it, through the procedure rather than the claim core
 * (`lib/request-secret.test.ts`): the owner-only insert policy on `requestedSecrets`, the Settings
 * save budget a provider key counts against (a refusal there rolls the stored value back with the
 * claim), a collaborator's refusal, and the continuation that is queued with a reference and nothing else.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

// `lib/encryption` reads the key when it loads.
const keyBytes = new Uint8Array(32);

crypto.getRandomValues(keyBytes);
vi.stubEnv("ENCRYPTION_KEY", btoa(String.fromCodePoint(...keyBytes)));

const registry = vi.hoisted(() => new Map<string, unknown>());
const queued = vi.hoisted(() => [] as { args: Record<string, unknown> }[]);
const budget = vi.hoisted(() => {
    return { exhausted: false };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) => {
            const { userId } = context.auth;

            return userId ? { activeOrganization: null, email: `${userId}@example.com`, id: userId, isAdmin: false, name: userId, userId } : null;
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

// Only the Settings save budget runs out; the procedure's own `chat/stream` limit passes.
vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async (context: { rateLimitKey?: string }) => {
            if (budget.exhausted && context.rateLimitKey === "byok/save") {
                throw new Error("Rate limit exceeded");
            }
        },
    };
});

vi.mock("../lib/job-queue", () => {
    return {
        enqueueJob: async (_ref: unknown, args: Record<string, unknown>) => {
            queued.push({ args });
        },
    };
});

const { default: schema } = await import("../schema");
const { answerSecretRequest } = await import("./request-secret");
const { decryptKey } = await import("../lib/encryption");

const OWNER = "user-owner";
const COLLABORATOR = "user-collaborator";
const SECRET = "sk-live-0123456789-supersecret";
const FILES_URL = "https://files.example.com/mcp";

const CONFIG = {
    autoMediaEnrichment: false,
    instructions: "system prompt",
    mcpServerNames: [],
    model: "test-model",
    replyKey: "stream-A",
    researchDepth: "balanced" as const,
    searchMode: "chat",
    shouldAutoContinue: true,
    startedBy: OWNER,
    toolNames: ["requestSecret"],
};

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;

const insertRequest = async (approvalId: string, input: unknown, order = 1, config: Record<string, unknown> = CONFIG) => {
    await harness.run(async (ctx: any) => {
        await ctx.db.insert("messages", {
            message: {
                content: [
                    { input, toolCallId: `call-${approvalId}`, toolName: "requestSecret", type: "tool-call" },
                    { approvalId, toolCallId: `call-${approvalId}`, type: "tool-approval-request" },
                ],
                role: "assistant",
            },
            order,
            status: "success",
            stepOrder: 0,
            threadId,
            tool: true,
            userId: OWNER,
        });
        await ctx.db.insert("toolApprovalRuns", { approvalId, config, createdAt: Date.now(), status: "pending", threadId, userId: OWNER });
    });
};

const answer = async (userId: string, value: string | null, approvalId = "sec-1") =>
    await harness.withIdentity({ userId } as never).mutation(answerSecretRequest as never, { approvalId, threadId, value } as never);

const RATE_LIMITED = /rate limit/iu;

const rows = async (table: string) => await harness.run(async (ctx: any) => await ctx.db.query(table).collect());

const runStatuses = async () => ((await rows("toolApprovalRuns")) as { status: string }[]).map((run) => run.status);

beforeAll(async () => {
    registerModule(registry, "chat_request_secret", await import("./request-secret"));
    registerModule(registry, "chat_streaming_persistent_library", await import("./streaming/persistent/library"));
}, 60_000);

beforeEach(async () => {
    budget.exhausted = false;
    queued.length = 0;
    harness = lunoraTest(schema as never);
    threadId = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId: OWNER }))) as string;
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("messages", { message: { content: "hi", role: "user" }, order: 0, status: "success", stepOrder: 0, threadId, userId: OWNER }),
    );
    await insertRequest("sec-1", { label: "OpenAI API key", use: { kind: "provider_key", provider: "openai" } });
});

afterEach(() => {
    harness.close();
});

describe("answerSecretRequest", () => {
    it("stores the value for the owner under the row-level policy and queues the continuation with the reference only", async () => {
        const result = (await answer(OWNER, SECRET)) as { alreadyResolved: boolean; streamId: string };

        expect(result).toMatchObject({ alreadyResolved: false, streamId: expect.any(String) });

        const [row] = (await rows("requestedSecrets")) as [{ encryptedValue: string; ref: string; userId: string }];

        expect(row).toMatchObject({ approvalId: "sec-1", userId: OWNER });
        expect(await decryptKey(row.encryptedValue, "provider-keys")).toBe(SECRET);

        expect(queued).toHaveLength(1);
        expect(queued[0]!.args).toMatchObject({ answer: row.ref, approvalId: "sec-1", approved: true, threadId, userId: OWNER });
        expect(JSON.stringify(queued)).not.toContain(SECRET);
        expect(JSON.stringify(await rows("persistentChunks"))).not.toContain(SECRET);
    });

    it("keeps who started the turn, and the reply it belongs to, in the snapshot the continuation resumes from", async () => {
        await answer(OWNER, SECRET);

        expect((queued[0]!.args as { config: { replyKey?: string; startedBy?: string } }).config).toMatchObject({ replyKey: "stream-A", startedBy: OWNER });
        expect(await rows("requestedSecrets")).toMatchObject([{ replyKey: "stream-A" }]);
    });

    it("refuses the owner's value for a turn a collaborator started, since no consumer could spend it, but lets them decline", async () => {
        await harness.run(async (ctx: any) => await ctx.db.insert("threadAccess", { ownerId: OWNER, permission: "write", threadId, userId: COLLABORATOR }));
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("messages", {
                    message: { content: "from the collaborator", role: "user" },
                    order: 2,
                    status: "success",
                    stepOrder: 0,
                    threadId,
                    userId: COLLABORATOR,
                }),
        );
        await insertRequest("sec-3", { label: "OpenAI API key", use: { kind: "provider_key", provider: "openai" } }, 3, { ...CONFIG, startedBy: COLLABORATOR });

        await expect(answer(OWNER, SECRET, "sec-3")).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(await rows("requestedSecrets")).toHaveLength(0);
        expect(queued).toHaveLength(0);

        await answer(OWNER, null, "sec-3");

        expect((queued[0]!.args as { config: { startedBy?: string } }).config.startedBy).toBe(COLLABORATOR);
        expect(queued[0]!.args).toMatchObject({ approved: false });
    });

    it("declining queues a denial and stores nothing", async () => {
        await answer(OWNER, null);

        expect(await rows("requestedSecrets")).toHaveLength(0);
        expect(queued[0]!.args).toMatchObject({ approved: false });
        expect(queued[0]!.args).not.toHaveProperty("answer");
    });

    it("refuses a write collaborator: only the owner's secret can be handed over, and only by the owner", async () => {
        await harness.run(async (ctx: any) => await ctx.db.insert("threadAccess", { ownerId: OWNER, permission: "write", threadId, userId: COLLABORATOR }));

        await expect(answer(COLLABORATOR, SECRET)).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(await rows("requestedSecrets")).toHaveLength(0);
        expect(await runStatuses()).toStrictEqual(["pending"]);
        expect(queued).toHaveLength(0);
    });

    it("rolls the stored value and the claim back when the Settings save budget for a provider key is spent", async () => {
        budget.exhausted = true;

        await expect(answer(OWNER, SECRET)).rejects.toThrow(RATE_LIMITED);

        expect(await rows("requestedSecrets")).toHaveLength(0);
        expect(await runStatuses()).toStrictEqual(["pending"]);
        expect(queued).toHaveLength(0);

        // The budget is only charged for a provider key: a decline does not need it.
        await answer(OWNER, null);

        expect(await runStatuses()).toStrictEqual(["denied"]);
    });

    it("does not charge the key budget for a header, and records the server's URL with the destination", async () => {
        budget.exhausted = true;

        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("aiUserPreferences", { mcpServers: [{ enabled: true, name: "Files", protocol: "http", url: FILES_URL }], userId: OWNER }),
        );
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("messages", {
                    message: { content: "and the files server", role: "user" },
                    order: 2,
                    status: "success",
                    stepOrder: 0,
                    threadId,
                    userId: OWNER,
                }),
        );
        await insertRequest("sec-2", { label: "Files token", use: { header: "Authorization", kind: "mcp_header", server: "Files" } }, 3);

        await answer(OWNER, SECRET, "sec-2");

        const [row] = (await rows("requestedSecrets")) as [{ use: unknown }];

        expect(row.use).toStrictEqual({ header: "Authorization", kind: "mcp_header", server: "Files", url: FILES_URL });
    });

    it("answers a second submit with the first outcome", async () => {
        await answer(OWNER, SECRET);

        await expect(answer(OWNER, "sk-other-0123456789")).resolves.toMatchObject({ alreadyResolved: true });
        expect(await rows("requestedSecrets")).toHaveLength(1);
        expect(queued).toHaveLength(1);
    });
});

describe("the Settings save and a stored header secret", () => {
    const save = async (args: Record<string, unknown>) => {
        const { updateAIUserPreferences } = await import("../auth/functions");

        return await harness.withIdentity({ userId: OWNER } as never).mutation(updateAIUserPreferences as never, args as never);
    };
    const secrets = async () => {
        const preferences = (await rows("aiUserPreferences")) as { mcpSecretHeaders?: unknown[] }[];

        return preferences[0]?.mcpSecretHeaders ?? [];
    };

    it("keeps them across a save that sends no server list and drops those whose server it moves or removes", async () => {
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("aiUserPreferences", {
                    mcpSecretHeaders: [{ encryptedValue: "v1:x", header: "Authorization", server: "Files", url: FILES_URL }],
                    mcpServers: [{ enabled: true, name: "Files", protocol: "http", url: FILES_URL }],
                    userId: OWNER,
                }),
        );

        await save({ enableKnowledge: true });
        expect(await secrets()).toHaveLength(1);

        await save({ mcpServers: [{ enabled: false, name: "Files", protocol: "http", url: FILES_URL }] });
        expect(await secrets()).toHaveLength(1);

        await save({ mcpServers: [{ enabled: true, name: "Files", protocol: "http", url: "https://moved.example.com/mcp" }] });
        expect(await secrets()).toHaveLength(0);
    });

    it("drops the secret, and the server, when the last server is removed (Settings sends an empty list)", async () => {
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("aiUserPreferences", {
                    mcpSecretHeaders: [{ encryptedValue: "v1:x", header: "Authorization", server: "Files", url: FILES_URL }],
                    mcpServers: [{ enabled: true, name: "Files", protocol: "http", url: FILES_URL }],
                    userId: OWNER,
                }),
        );

        await save({ mcpServers: [] });
        expect(await secrets()).toHaveLength(0);

        const preferences = (await rows("aiUserPreferences")) as { mcpServers?: unknown[] }[];

        expect(preferences[0]?.mcpServers ?? []).toHaveLength(0);
    });

    it("drops the secret when the user types that header by hand", async () => {
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("aiUserPreferences", {
                    mcpSecretHeaders: [{ encryptedValue: "v1:x", header: "Authorization", server: "Files", url: FILES_URL }],
                    mcpServers: [{ enabled: true, name: "Files", protocol: "http", url: FILES_URL }],
                    userId: OWNER,
                }),
        );

        await save({
            mcpServers: [{ enabled: true, headers: [{ key: "authorization", value: "typed-by-hand" }], name: "Files", protocol: "http", url: FILES_URL }],
        });
        expect(await secrets()).toHaveLength(0);
    });
});
