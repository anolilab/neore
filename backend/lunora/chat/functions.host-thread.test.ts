/**
 * A host-run thread's turns are produced on a paired computer, so its messages never go to a cloud model: the
 * summary and follow-up actions, which read the thread and call one, refuse it (`http.host-thread.test.ts` pins
 * the chat entry points).
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import { BRANCH_ROOT } from "../agent/branch-tree";
import { MAX_LENGTH } from "../lib/validators";
import schema from "../schema";
import {
    branchThread,
    continueThread,
    generateSummary,
    getFollowupSuggestions,
    admitTitleCharge,
    promptById,
    refusedBeforeDispatch,
    regenerateThreadTitle,
    titleIneligibility,
    titleUsageEvent,
} from "./functions";

const OWNER = "user-owner";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: null, id: context.auth.userId, userId: context.auth.userId } : null,
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
let threadId: string;

beforeAll(async () => {
    registerModule(registry, "chat_functions", await import("./functions"));
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "lib_claim_once", await import("../lib/claim-once"));
    registerModule(registry, "agent_branches", await import("../agent/branches"));
    registerModule(registry, "agent_messages", await import("../agent/messages"));
}, 30_000);

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    threadId = (await harness.run(
        async (ctx: any) => await ctx.db.insert("threads", { model: "gpt-4o", runner: "host", status: "active", title: "Agent", userId: OWNER }),
    )) as string;
});

afterEach(() => {
    harness.close();
});

/**
 * Appends a message to a thread's tree: a row with no parent is a root; any other row is linked by `parentMessageId`, as a branch stores
 * it. A parent must come before its child in storage order (`order` rises down a branch), so every row takes the next order.
 */
let lastOrder = 0;

const appendMessage = async (thread: string, parent: string | undefined, fields: Record<string, unknown>): Promise<string> => {
    lastOrder += 1;

    const order = lastOrder;

    return (await harness.run(
        async (context: any) =>
            await context.db.insert("messages", {
                order,
                status: "success",
                stepOrder: 0,
                threadId: thread,
                tool: false,
                userId: OWNER,
                ...(parent !== undefined && { parentMessageId: parent }),
                ...fields,
            }),
    )) as string;
};

describe("a host-run thread", () => {
    it("has no summary generated from its messages", async () => {
        await expect(harness.withIdentity({ userId: OWNER }).action(generateSummary as never, { threadId } as never)).rejects.toMatchObject({
            code: "CONFLICT",
        });
    });

    it("gets no regenerated title either: its messages must not reach a cloud model", async () => {
        await expect(harness.withIdentity({ userId: OWNER }).action(regenerateThreadTitle as never, { threadId } as never)).rejects.toMatchObject({
            code: "CONFLICT",
        });
    });

    it("gets no follow-up suggestions, and no error for asking", async () => {
        await expect(harness.withIdentity({ userId: OWNER }).action(getFollowupSuggestions as never, { threadId } as never)).resolves.toEqual({
            suggestions: [],
        });
    });

    it("cannot be forked into a cloud thread", async () => {
        await expect(harness.withIdentity({ userId: OWNER }).action(branchThread as never, { threadId } as never)).rejects.toMatchObject({
            code: "CONFLICT",
        });
    });
});

describe("the last check before a background model call", () => {
    const insertCloud = async (fields: Record<string, unknown>) =>
        (await harness.run(
            async (context: any) => await context.db.insert("threads", { model: "gpt-4o", status: "active", title: "Cloud", userId: OWNER, ...fields }),
        )) as string;

    it("refuses a locked or deleted thread just before the call, and allows an open one", async () => {
        const locked = await insertCloud({ lockedAt: 1000 });
        const deleted = await insertCloud({ deletedAt: 1000 });
        const open = await insertCloud({});

        await expect(harness.run(async (context: any) => await refusedBeforeDispatch(context, locked))).resolves.toBe(true);
        await expect(harness.run(async (context: any) => await refusedBeforeDispatch(context, deleted))).resolves.toBe(true);
        await expect(harness.run(async (context: any) => await refusedBeforeDispatch(context, open))).resolves.toBe(false);
    });
});

describe("the prompt a title is written from, and the charge for it", () => {
    const insertCloud = async () =>
        (await harness.run(
            async (context: any) => await context.db.insert("threads", { model: "gpt-4o", status: "active", title: "Cloud", userId: OWNER }),
        )) as string;

    it("re-reads the prompt the request found by its id, and gives none for a row that is not a successful user prompt", async () => {
        const cloud = await insertCloud();
        const prompt = await appendMessage(cloud, undefined, { message: { content: "Plan a trip", role: "user" } });
        const reply = await appendMessage(cloud, prompt, { message: { content: "Sure", role: "assistant" } });

        await expect(harness.run(async (context: any) => await promptById(context, cloud, prompt))).resolves.toEqual({ id: prompt, text: "Plan a trip" });
        await expect(harness.run(async (context: any) => await promptById(context, cloud, reply))).resolves.toBeUndefined();
    });

    it("admits a title's model call once per key, so a retried run that reaches the call again is refused", async () => {
        const key = "thread-x:run-1";

        await expect(harness.run(async (context: any) => await admitTitleCharge(context, key, OWNER))).resolves.toBe(true);
        await expect(harness.run(async (context: any) => await admitTitleCharge(context, key, OWNER))).resolves.toBe(false);
    });

    it("refuses a chat whose path is past the limit with a visible conflict, before it claims the regenerate", async () => {
        const cloud = await insertCloud();
        let parent = await appendMessage(cloud, undefined, { message: { content: "Plan a trip", role: "user" } });

        for (let index = 0; index < 1000; index += 1) {
            parent = await appendMessage(cloud, parent, { message: { content: `Reply ${index}`, role: "assistant" } });
        }

        await harness.run(async (context: any) => await context.db.patch("threads", cloud, { activeLeafMessageId: parent }));

        await expect(harness.withIdentity({ userId: OWNER }).action(regenerateThreadTitle as never, { threadId: cloud } as never)).rejects.toMatchObject({
            message: expect.stringContaining("too long"),
        });
        const claims = (await harness.run(async (context: any) => await context.db.query("idempotencyClaims").collect())) as {
            key: string;
            scope: string;
        }[];

        expect(claims.some((claim) => claim.scope === "regenerate-title" && claim.key === cloud)).toBe(false);
    }, 60_000);
});

describe("continueThread", () => {
    it("refuses a prompt that is empty once the hidden characters are gone, before it touches the thread", async () => {
        await expect(
            harness.withIdentity({ userId: OWNER }).action(continueThread as never, { model: "gpt-4o", prompt: "\u{E0041}\u{202E}", threadId } as never),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
});

describe("regenerating the title of a cloud thread", () => {
    const GRANTEE = "user-grantee";

    const insertThread = async (fields: Record<string, unknown> = {}) =>
        (await harness.run(
            async (context: any) => await context.db.insert("threads", { model: "gpt-4o", status: "active", title: "Shared", userId: OWNER, ...fields }),
        )) as string;

    /** A cloud thread whose first message is a user prompt, so there is a prompt to title it from. */
    const cloudThread = async (fields: Record<string, unknown> = {}) => {
        const created = await insertThread(fields);

        await harness.run(async (context: any) => {
            await context.db.insert("messages", {
                message: { content: "Plan a trip to Lisbon", role: "user" },
                order: 0,
                status: "success",
                stepOrder: 0,
                threadId: created,
                tool: false,
                userId: OWNER,
            });
        });

        return created;
    };

    /** The thread ids that hold a regenerate claim. */
    const regenerateClaimKeys = async (): Promise<string[]> => {
        const claims = (await harness.run(async (context: any) => await context.db.query("idempotencyClaims").collect())) as {
            key: string;
            scope: string;
        }[];

        return claims.filter((claim) => claim.scope === "regenerate-title").map((claim) => claim.key);
    };

    const grant = async (grantedThreadId: string, permission: "read" | "write") => {
        await harness.run(async (context: any) => {
            await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission, threadId: grantedThreadId, userId: GRANTEE });
        });
    };

    it("accepts the owner's request", async () => {
        const cloud = await cloudThread();

        await expect(harness.withIdentity({ userId: OWNER }).action(regenerateThreadTitle as never, { threadId: cloud } as never)).resolves.toEqual({
            success: true,
        });
    });

    it("refuses a chat with no user prompt to title it from, and schedules nothing", async () => {
        const empty = await insertThread();

        await expect(harness.withIdentity({ userId: OWNER }).action(regenerateThreadTitle as never, { threadId: empty } as never)).rejects.toMatchObject({
            code: "CONFLICT",
        });
        expect(await regenerateClaimKeys()).not.toContain(empty);
    });

    it("refuses a request made while one is in flight, and holds one claim", async () => {
        const cloud = await cloudThread();
        const owner = harness.withIdentity({ userId: OWNER });

        await expect(owner.action(regenerateThreadTitle as never, { threadId: cloud } as never)).resolves.toEqual({ success: true });
        await expect(owner.action(regenerateThreadTitle as never, { threadId: cloud } as never)).rejects.toMatchObject({ code: "CONFLICT" });

        const keys = await regenerateClaimKeys();

        expect(keys.filter((key) => key === cloud)).toHaveLength(1);
    });

    it("titles a chat whose stored leaf is gone from the path the thread shows, not refused as having no prompt", async () => {
        const cloud = await cloudThread();

        await harness.run(async (context: any) => {
            const gone = await context.db.insert("messages", {
                message: { content: "A prompt on an abandoned branch", role: "user" },
                order: 1,
                status: "success",
                stepOrder: 0,
                threadId: cloud,
                tool: false,
                userId: OWNER,
            });

            await context.db.delete("messages", gone);
            await context.db.patch("threads", cloud, { activeLeafMessageId: gone });
        });

        await expect(harness.withIdentity({ userId: OWNER }).action(regenerateThreadTitle as never, { threadId: cloud } as never)).resolves.toEqual({
            success: true,
        });
        expect(await regenerateClaimKeys()).toContain(cloud);
    });

    it("refuses a duplicate click at the claim, before it reads the prompt", async () => {
        const cloud = await cloudThread();
        const owner = harness.withIdentity({ userId: OWNER });

        await owner.action(regenerateThreadTitle as never, { threadId: cloud } as never);

        // The prompt is gone, so a read would find none: only the claim can explain the refusal.
        await harness.run(async (context: any) => {
            const rows = await context.db.query("messages").collect();

            for (const row of rows) {
                if (row.threadId === cloud) {
                    await context.db.delete("messages", row._id);
                }
            }
        });

        await expect(owner.action(regenerateThreadTitle as never, { threadId: cloud } as never)).rejects.toMatchObject({
            message: expect.stringContaining("already being generated"),
        });
    });

    it("titles a long branched chat from a prompt past the first page of its path", async () => {
        const cloud = await insertThread({});
        let parent: string | undefined;

        for (let index = 0; index < 520; index += 1) {
            parent = await appendMessage(cloud, parent, { message: { content: `Reply ${index}`, role: "assistant" } });
        }

        const prompt = await appendMessage(cloud, parent, { message: { content: "Plan a trip to Lisbon", role: "user" } });
        const reply = await appendMessage(cloud, prompt, { message: { content: "Sure", role: "assistant" } });

        await harness.run(async (context: any) => await context.db.patch("threads", cloud, { activeLeafMessageId: reply }));

        await expect(harness.withIdentity({ userId: OWNER }).action(regenerateThreadTitle as never, { threadId: cloud } as never)).resolves.toEqual({
            success: true,
        });
        // 520 rows written one by one: the explicit timeout is the repo's pattern for such a test, so a loaded runner does not fail it.
    }, 30_000);

    it("retitles a chat whose stored title is longer than the title limit", async () => {
        const cloud = await cloudThread({ title: "x".repeat(MAX_LENGTH.long + 1) });

        await expect(harness.withIdentity({ userId: OWNER }).action(regenerateThreadTitle as never, { threadId: cloud } as never)).resolves.toEqual({
            success: true,
        });
    });

    it("keeps a title while its prompt is still on the active path, and drops it once the prompt is on another branch", async () => {
        const cloud = await insertThread({});
        const prompt = await appendMessage(cloud, undefined, { message: { content: "Plan a trip", role: "user" } });

        await appendMessage(cloud, prompt, { message: { content: "Sure", role: "assistant" } });

        // A later reply regenerated: the leaf moved to a sibling reply, but the prompt is still on the path.
        const regenerated = await appendMessage(cloud, prompt, { message: { content: "Certainly", role: "assistant" } });

        await harness.run(async (context: any) => await context.db.patch("threads", cloud, { activeLeafMessageId: regenerated }));
        await expect(harness.run(async (context: any) => await titleIneligibility(context, { expectedPromptId: prompt, threadId: cloud }))).resolves.toBe(
            undefined,
        );

        // The first prompt was edited: the edit is another root, so the original prompt is on no path now.
        // The edit is a root of its own: marked BRANCH_ROOT, so it does not adopt the row before it in storage order.
        const edited = await appendMessage(cloud, BRANCH_ROOT, { message: { content: "Plan a trip to Porto", role: "user" } });

        await harness.run(async (context: any) => await context.db.patch("threads", cloud, { activeLeafMessageId: edited }));
        await expect(harness.run(async (context: any) => await titleIneligibility(context, { expectedPromptId: prompt, threadId: cloud }))).resolves.toBe(
            "branch-switched",
        );
    });

    it("records a title call's tokens and model whether or not the title was written", () => {
        expect(titleUsageEvent("model-a", { inputTokens: 5, outputTokens: 2 })).toStrictEqual({ inputTokens: 5, model: "model-a", outputTokens: 2 });
        expect(titleUsageEvent("model-a", { inputTokens: 5, outputTokens: 2 }, "changed-before-write")).toStrictEqual({
            inputTokens: 5,
            model: "model-a",
            outputTokens: 2,
            skipped: "changed-before-write",
        });
    });

    it("does not coalesce requests for different threads", async () => {
        const first = await cloudThread();
        const second = await cloudThread();
        const owner = harness.withIdentity({ userId: OWNER });

        await owner.action(regenerateThreadTitle as never, { threadId: first } as never);
        await owner.action(regenerateThreadTitle as never, { threadId: second } as never);

        expect(await regenerateClaimKeys()).toEqual(expect.arrayContaining([first, second]));
    });

    it("refuses a locked chat, whose title is its content", async () => {
        const locked = await cloudThread({ lockedAt: 1000 });

        await expect(harness.withIdentity({ userId: OWNER }).action(regenerateThreadTitle as never, { threadId: locked } as never)).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
    });

    it("refuses a grantee who may only read the thread", async () => {
        const cloud = await cloudThread();

        await grant(cloud, "read");

        await expect(harness.withIdentity({ userId: GRANTEE }).action(regenerateThreadTitle as never, { threadId: cloud } as never)).rejects.toThrow();
    });

    it("refuses a grantee with write access: a regenerate is admin-only, as a rename is", async () => {
        const cloud = await cloudThread();

        await grant(cloud, "write");

        await expect(harness.withIdentity({ userId: GRANTEE }).action(regenerateThreadTitle as never, { threadId: cloud } as never)).rejects.toThrow();
    });
});
