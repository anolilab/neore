/**
 * A side question reads the thread and writes nothing: no message rows, no
 * change to the running stream or the active branch. "Add to thread" is the
 * only write, and it writes exactly one row, never while a reply is running.
 */
import { DEFAULT_MEMORY_EXTRACTION_MODEL } from "@neore/ai/constants";
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

const { generateText, getAgent, getUtilityModel, registry, sessionFrom, users } = vi.hoisted(() => {
    return {
        generateText: vi.fn(),
        getAgent: vi.fn(),
        getUtilityModel: vi.fn(),
        registry: new Map<string, unknown>(),
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId
                ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, plan: null, role: null, userId: context.auth.userId }
                : null,
        users: new Map<string, { isAnonymous?: boolean }>(),
    };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

vi.mock("ai", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("ai")>()), generateText };
});

vi.mock("../lib/utility-model", () => {
    return { getUtilityModel };
});

vi.mock("./lib/get-agent", () => {
    return { default: getAgent };
});

vi.mock("./lib/agent-run", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("./lib/agent-run")>()),
        loadModelFilterRules: async () => {
            return {};
        },
        loadUserProviderKeys: async () => undefined,
        resolveRunModel: async () => {
            return { allowTools: true, customProvider: undefined };
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
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async () => undefined,
    };
});

// `user` is a `.global()` (D1) table the in-memory harness cannot write.
vi.mock("../auth/lib/better-auth-queries", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth/lib/better-auth-queries")>()),
        getUser: async (_ctx: unknown, userId: string) => {
            const user = users.get(userId);

            return user ? { _id: userId, ...user } : null;
        },
    };
});

beforeAll(async () => {
    registerModule(registry, "auth_functions", await import("../auth/functions"));
    registerModule(registry, "lib_rate_limiter_mutations", await import("../lib/rate-limiter-mutations"));
    registerModule(registry, "chat_functions", await import("./functions"));
    registerModule(registry, "chat_aside", await import("./aside"));
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "chat_streaming_persistent_library", await import("./streaming/persistent/library"));
});

// eslint-disable-next-line import/first -- the mocks above must be hoisted before these load
import { addMessagesHandler } from "../agent/messages";
// eslint-disable-next-line import/first
import { createRatelimit } from "../lib/rate-limiter";
// eslint-disable-next-line import/first
import schema from "../schema";
// eslint-disable-next-line import/first
import { addAsideToThread, askAside } from "./aside";

type Harness = ReturnType<typeof lunoraTest>;

const OWNER = "owner-user";
const OTHER = "other-user";

let harness: Harness;
let threadId: string;
let streamId: string;

const as = (userId: string) => harness.withIdentity({ userId } as never);

const ask = async (question = "What does idempotent mean?", userId = OWNER): Promise<{ answer: string; withThread: boolean }> =>
    (await as(userId).action(askAside as never, { question, threadId } as never)) as { answer: string; withThread: boolean };

const addToThread = async (userId = OWNER): Promise<{ messageId: string }> =>
    (await as(userId).mutation(
        addAsideToThread as never,
        { answer: "It means safe to repeat.", question: "What does idempotent mean?", threadId } as never,
    )) as {
        messageId: string;
    };

const rows = async (table: string): Promise<any[]> => await harness.run(async (ctx: any) => await ctx.db.query(table).collect());

const remainingText = async (userId: string): Promise<number> =>
    await harness.run(async (ctx: any) => {
        const { remaining } = await createRatelimit("chat/dailyText:free", ctx.db as never).getRemaining(userId);

        return remaining;
    });

/** Everything a side question must leave as it found it. */
const threadState = async () => {
    const [thread] = await rows("threads");

    return { messages: await rows("messages"), streams: await rows("persistentStreams"), thread };
};

const insertStream = async (fields: Record<string, unknown> = {}): Promise<string> =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("persistentStreams", {
                expiresAt: Date.now() + 60_000,
                messageId: "prompt",
                status: "streaming",
                streamingConfig: { contentType: "text", model: DEFAULT_MEMORY_EXTRACTION_MODEL },
                threadId,
                userId: OWNER,
                ...fields,
            }),
    );

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    users.set(OWNER, {});
    users.set(OTHER, {});
    generateText.mockResolvedValue({ text: "  It means safe to repeat.  " });
    getAgent.mockResolvedValue({ options: { languageModel: { id: "thread-model" } } });
    getUtilityModel.mockResolvedValue({ id: "utility-model" });

    threadId = await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("threads", { mode: "text", model: DEFAULT_MEMORY_EXTRACTION_MODEL, status: "active", title: "T", userId: OWNER }),
    );

    await harness.run(
        async (ctx: any) =>
            await addMessagesHandler(ctx, {
                messages: [
                    { message: { content: "refactor the importer", role: "user" } },
                    { message: { content: [{ text: "Working on the importer now.", type: "text" }], role: "assistant" }, status: "success" },
                ],
                threadId,
                userId: OWNER,
            } as never),
    );
    streamId = await insertStream();
});

afterEach(() => {
    harness.close();
    users.clear();
    generateText.mockReset();
    getAgent.mockReset();
    getUtilityModel.mockReset();
});

describe("askAside", () => {
    it("answers from the thread's own model, with the thread as context and no tools", async () => {
        await expect(ask()).resolves.toStrictEqual({ answer: "It means safe to repeat.", withThread: true });

        expect(getAgent).toHaveBeenCalledWith(DEFAULT_MEMORY_EXTRACTION_MODEL, expect.objectContaining({ threadId, userId: OWNER }));
        expect(generateText).toHaveBeenCalledOnce();

        const call = generateText.mock.calls[0]![0];

        expect(call.model).toStrictEqual({ id: "thread-model" });
        expect(call.prompt).toContain("refactor the importer");
        expect(call.prompt).toContain("Working on the importer now.");
        expect(call.prompt).toContain("What does idempotent mean?");
        expect(call).not.toHaveProperty("tools");
    });

    it("writes no message and leaves the running stream and the thread as they were", async () => {
        const before = await threadState();

        await ask();
        await ask("And what about retries?");

        expect(await threadState()).toStrictEqual(before);
        expect(before.streams.map((stream) => stream._id)).toStrictEqual([streamId]);
    });

    it("works with no reply running", async () => {
        await harness.run(async (ctx: any) => await ctx.db.patch(streamId, { status: "done" }));

        await expect(ask()).resolves.toMatchObject({ answer: "It means safe to repeat." });
    });

    it("charges the daily text quota once per question", async () => {
        const before = await remainingText(OWNER);

        await ask();

        expect(await remainingText(OWNER)).toBe(before - 1);
    });

    it("sends only the question to the utility model on a coding agent's thread", async () => {
        await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { runner: "host" }));

        await expect(ask()).resolves.toStrictEqual({ answer: "It means safe to repeat.", withThread: false });

        expect(getAgent).not.toHaveBeenCalled();
        expect(generateText.mock.calls[0]![0].model).toStrictEqual({ id: "utility-model" });
        expect(generateText.mock.calls[0]![0].prompt).not.toContain("importer");
    });

    it("uses the utility model for a thread that is not on a text model", async () => {
        await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { mode: "image", model: "not-a-text-model" }));

        await expect(ask()).resolves.toMatchObject({ withThread: true });

        expect(getAgent).not.toHaveBeenCalled();
        expect(generateText.mock.calls[0]![0].model).toStrictEqual({ id: "utility-model" });
    });

    it("refuses someone with no access to the thread, before any model call or charge", async () => {
        const before = await remainingText(OTHER);

        await expect(ask("What does idempotent mean?", OTHER)).rejects.toThrow();

        expect(generateText).not.toHaveBeenCalled();
        expect(await remainingText(OTHER)).toBe(before);
    });

    it("refuses an empty question", async () => {
        await expect(ask(" ".repeat(3))).rejects.toThrow("Ask a question first");
        expect(generateText).not.toHaveBeenCalled();
    });
});

describe("addAsideToThread", () => {
    it("is refused while a reply is running, and writes nothing", async () => {
        const before = await rows("messages");

        await expect(addToThread()).rejects.toThrow("Wait for the reply");

        expect(await rows("messages")).toStrictEqual(before);
    });

    it("writes exactly one assistant message once the reply has finished", async () => {
        await harness.run(async (ctx: any) => await ctx.db.patch(streamId, { status: "done" }));

        const before = await rows("messages");
        const { messageId } = await addToThread();
        const after = await rows("messages");

        expect(after).toHaveLength(before.length + 1);

        const added = after.find((row) => row._id === messageId);

        expect(added).toMatchObject({ agentName: "Side question", message: { role: "assistant" }, status: "success" });
        expect(added.order).toBeGreaterThan(Math.max(...before.map((row) => row.order)));
        expect(added.message.content).toBe("**Side question**\n\n> What does idempotent mean?\n\nIt means safe to repeat.");
    });

    it("refuses a collaborator with write access: the row reads as the assistant's own", async () => {
        await harness.run(async (ctx: any) => await ctx.db.patch(streamId, { status: "done" }));
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, ownerId: OWNER, permission: "write", threadId, userId: OTHER }),
        );

        await expect(addToThread(OTHER)).rejects.toThrow("Only the owner");

        expect(await rows("messages")).toHaveLength(2);
    });

    it("refuses someone with no write access to the thread", async () => {
        await harness.run(async (ctx: any) => await ctx.db.patch(streamId, { status: "done" }));

        await expect(addToThread(OTHER)).rejects.toThrow();

        expect(await rows("messages")).toHaveLength(2);
    });
});
