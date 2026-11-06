/**
 * A host-run thread's turns are produced on a paired computer, so its messages never go to a cloud model: the
 * summary and follow-up actions, which read the thread and call one, refuse it (`http.host-thread.test.ts` pins
 * the chat entry points).
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import schema from "../schema";
import { branchThread, continueThread, generateSummary, getFollowupSuggestions, regenerateThreadTitle } from "./functions";

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

    it("refuses a stored leaf that no longer exists, rather than titling from another branch", async () => {
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

        await expect(harness.withIdentity({ userId: OWNER }).action(regenerateThreadTitle as never, { threadId: cloud } as never)).rejects.toMatchObject({
            code: "CONFLICT",
        });
        expect(await regenerateClaimKeys()).not.toContain(cloud);
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
