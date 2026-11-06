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

    const cloudThread = async (fields: Record<string, unknown> = {}) =>
        (await harness.run(
            async (context: any) => await context.db.insert("threads", { model: "gpt-4o", status: "active", title: "Shared", userId: OWNER, ...fields }),
        )) as string;

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
