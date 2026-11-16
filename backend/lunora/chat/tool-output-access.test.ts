/**
 * `getToolOutput` hands back one tool result the thread page left out. It must reach the owner
 * only: a stranger, a public (redacted) view, a locked thread without its proof, a row from another
 * thread and a missing call all fail or return nothing.
 */
import { describe, expect, it, vi } from "vitest";

import { lunoraTest } from "@lunora/testing";

import schema from "../schema";
import { getToolOutput } from "./functions";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: { id: "org-1" }, id: context.auth.userId, userId: context.auth.userId } : null,
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const RESULT = { output: { type: "text", value: "full tool output" }, toolCallId: "call-1", toolName: "docs_search", type: "tool-result" };

/** Seeds one thread with a tool call and its result row; returns the ids the query needs. */
const seed = async (context: any, extra: Record<string, unknown> = {}) => {
    const threadId = await context.db.insert("threads", { model: "m", status: "active", title: "t", userId: OWNER, ...extra });

    await context.db.insert("messages", {
        message: { content: [{ input: {}, toolCallId: "call-1", toolName: "docs_search", type: "tool-call" }], role: "assistant" },
        order: 0,
        status: "success",
        stepOrder: 1,
        threadId,
        tool: true,
        userId: OWNER,
    });
    const resultId = await context.db.insert("messages", {
        message: { content: [RESULT], role: "tool" },
        order: 0,
        status: "success",
        stepOrder: 2,
        threadId,
        tool: true,
        userId: OWNER,
    });

    return { resultId, threadId };
};

describe("getToolOutput access", () => {
    it("returns the stored output to the owner, unwrapped as the page unwraps it", async () => {
        const harness = lunoraTest(schema as never);
        const { resultId, threadId } = await harness.run((context: any) => seed(context));

        const result = await harness
            .withIdentity({ userId: OWNER })
            .query(getToolOutput as never, { messageId: resultId, threadId, toolCallId: "call-1" } as never);

        expect(result).toStrictEqual({ output: "full tool output" });
    });

    it("refuses a signed-in stranger with no grant", async () => {
        const harness = lunoraTest(schema as never);
        const { resultId, threadId } = await harness.run((context: any) => seed(context));

        await expect(
            harness.withIdentity({ userId: STRANGER }).query(getToolOutput as never, { messageId: resultId, threadId, toolCallId: "call-1" } as never),
        ).rejects.toThrow();
    });

    it("refuses a public (redacted) view, which never carries tool output", async () => {
        const harness = lunoraTest(schema as never);
        const { resultId, threadId } = await harness.run((context: any) => seed(context, { isPublic: true }));

        await expect(
            harness.withIdentity({ userId: STRANGER }).query(getToolOutput as never, { messageId: resultId, threadId, toolCallId: "call-1" } as never),
        ).rejects.toThrow();
    });

    it("refuses a locked thread when the owner has no unlock proof", async () => {
        const harness = lunoraTest(schema as never);
        const { resultId, threadId } = await harness.run((context: any) => seed(context, { lockedAt: Date.now() }));

        await expect(
            harness.withIdentity({ userId: OWNER }).query(getToolOutput as never, { messageId: resultId, threadId, toolCallId: "call-1" } as never),
        ).rejects.toThrow();
    });

    it("refuses a row that belongs to another thread the owner also holds", async () => {
        const harness = lunoraTest(schema as never);
        const { resultId } = await harness.run((context: any) => seed(context));
        const { threadId: otherThreadId } = await harness.run((context: any) => seed(context));

        await expect(
            harness
                .withIdentity({ userId: OWNER })
                .query(getToolOutput as never, { messageId: resultId, threadId: otherThreadId, toolCallId: "call-1" } as never),
        ).rejects.toThrow();
    });

    it("returns nothing for a tool call id the row does not hold", async () => {
        const harness = lunoraTest(schema as never);
        const { resultId, threadId } = await harness.run((context: any) => seed(context));

        const result = await harness
            .withIdentity({ userId: OWNER })
            .query(getToolOutput as never, { messageId: resultId, threadId, toolCallId: "no-such-call" } as never);

        expect(result).toStrictEqual({});
    });
});
