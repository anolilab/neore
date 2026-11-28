/**
 * The forget tool: the runs it never deletes from, and the confirmation a call naming memories always waits for.
 */
import { describe, expect, it, vi } from "vitest";

import { applyToolPermissions, toolPermissionKey } from "../lib/tool-permissions";
import forgetTool from "./forget";

const TURN = { impersonated: false, promptMessageId: "prompt-1", systemContext: [] };
const CONFIRMED = { memories: [{ id: "m1", text: "User lives in Berlin" }] };
const LOOKUP = { query: "User lives in Berlin" };

/** `wrapTools` attaches the agent's ctx to the tool object; `execute` reads it from there. */
const run = (context: unknown, input: unknown) =>
    (forgetTool as unknown as { execute: (input: unknown, options: unknown) => unknown }).execute.call({ ...forgetTool, ctx: context }, input, {});

const contextWith = (extra: object) => {
    return {
        runAction: vi.fn(async () => {
            return { deleted: ["User lives in Berlin"], status: "deleted" };
        }),
        threadId: "thread-1",
        userId: "user-1",
        ...extra,
    };
};

type Approval = (input: unknown, options: unknown) => boolean | Promise<boolean>;

const asks = async (tool: unknown, input: unknown): Promise<boolean> => {
    const own = (tool as { needsApproval?: boolean | Approval }).needsApproval;

    return typeof own === "function"
        ? await own.call({ ...(tool as object), ctx: contextWith({}) }, input, { messages: [], toolCallId: "call-1" })
        : own === true;
};

describe("forget", () => {
    it("names the turn's own prompt and reply, and passes a lookup or the confirmed memories", async () => {
        const context = contextWith({ promptMessageId: "last-row", replyKey: "stream-1", runTurn: TURN });

        await run(context, LOOKUP);
        await run(context, CONFIRMED);

        expect(context.runAction).toHaveBeenNthCalledWith(
            1,
            expect.anything(),
            expect.objectContaining({ promptMessageId: "prompt-1", query: LOOKUP.query, replyKey: "stream-1" }),
        );
        expect(context.runAction).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({ memories: CONFIRMED.memories }));
    });

    it("deletes nothing in a run nobody is at, or one that recorded no turn", async () => {
        const headless = contextWith({ headless: true, runTurn: TURN });
        const noTurn = contextWith({});

        await expect(run(headless, CONFIRMED)).resolves.toStrictEqual({ deleted: [], status: "not_private" });
        await expect(run(noTurn, LOOKUP)).resolves.toStrictEqual({ deleted: [], status: "not_private" });
        expect(headless.runAction).not.toHaveBeenCalled();
        expect(noTurn.runAction).not.toHaveBeenCalled();
    });

    it("says a memory merged into another that no longer matches was not deleted, and that the user can ask again", () => {
        const tool = { ...forgetTool, ctx: contextWith({}) } as unknown as {
            toModelOutput: (options: { input: unknown; output: unknown; toolCallId: string }) => unknown;
        };
        const encoded = JSON.stringify(
            tool.toModelOutput({ input: CONFIRMED, output: { deleted: [], gone: 1, merged: 1, status: "nothing_found" }, toolCallId: "call-1" }),
        );

        expect(encoded).toContain("merged into another memory that no longer matches what the user was shown");
        expect(encoded).toContain("ask again in their own words");
        expect(encoded).not.toContain("listed under candidates");
    });

    it("says a memory that could not be checked was not deleted, and to try again in a moment", () => {
        const tool = { ...forgetTool, ctx: contextWith({}) } as unknown as {
            toModelOutput: (options: { input: unknown; output: unknown; toolCallId: string }) => unknown;
        };
        const encoded = JSON.stringify(
            tool.toModelOutput({ input: CONFIRMED, output: { deleted: [], status: "nothing_found", unchecked: 1 }, toolCallId: "call-1" }),
        );

        expect(encoded).toContain("could not be checked right now");
        expect(encoded).toContain("try again in a moment");
        expect(encoded).not.toContain("merged into another memory");
    });

    it("says what was deleted before the chat was shared, without claiming nothing was", () => {
        const tool = { ...forgetTool, ctx: contextWith({}) } as unknown as {
            toModelOutput: (options: { input: unknown; output: unknown; toolCallId: string }) => unknown;
        };
        const encoded = JSON.stringify(
            tool.toModelOutput({ input: CONFIRMED, output: { deleted: [], deletedCount: 1, status: "not_private" }, toolCallId: "call-1" }),
        );

        expect(encoded).toContain("1 confirmed memories were deleted as the user approved");
        expect(encoded).not.toContain("Nothing was deleted");
    });

    it("names memory being turned off as the reason a deleted memory's text is withheld", () => {
        const tool = { ...forgetTool, ctx: contextWith({}) } as unknown as {
            toModelOutput: (options: { input: unknown; output: unknown; toolCallId: string }) => unknown;
        };
        const encoded = JSON.stringify(
            tool.toModelOutput({ input: CONFIRMED, output: { deleted: [], deletedCount: 1, status: "memory_off" }, toolCallId: "call-1" }),
        );

        expect(encoded).toContain("because memory was turned off");
        expect(encoded).not.toContain("no longer the user's alone");
    });

    it("tells the model that memory off still leaves deleting in settings", () => {
        const tool = { ...forgetTool, ctx: contextWith({}) } as unknown as {
            toModelOutput: (options: { input: unknown; output: unknown; toolCallId: string }) => unknown;
        };

        expect(JSON.stringify(tool.toModelOutput({ input: LOOKUP, output: { deleted: [], status: "memory_off" }, toolCallId: "call-1" }))).toContain(
            "They can still delete memories in Settings",
        );
    });
});

describe("forget's permissions", () => {
    const key = toolPermissionKey("builtin", "forget");
    const tools = { forget: forgetTool } as never;

    it("asks before deleting the memories named, in every mode and under an hour or today allow", async () => {
        const now = Date.UTC(2026, 10, 28, 12, 0, 0);

        vi.useFakeTimers({ now });
        const auto = applyToolPermissions(tools, () => undefined, undefined).tools.forget;
        const full = applyToolPermissions(tools, () => undefined, undefined, { threadMode: "full" }).tools.forget;
        const granted = applyToolPermissions(tools, () => undefined, { [key]: "ask" }, { now, timedGrants: { [key]: now + 60_000 } }).tools.forget;

        for (const tool of [auto, full, granted]) {
            await expect(asks(tool, CONFIRMED)).resolves.toBe(true);
            await expect(asks(tool, LOOKUP)).resolves.toBe(false);
        }

        vi.useRealTimers();
    });

    it("asks for a lookup too when set to Ask, and is removed from a run nobody is at", async () => {
        const asked = applyToolPermissions(tools, () => undefined, { [key]: "ask" }).tools.forget;
        const { removed } = applyToolPermissions(tools, () => undefined, { [key]: "auto" }, { headless: true });

        await expect(asks(asked, LOOKUP)).resolves.toBe(true);
        expect(removed).toContain("forget");
    });
});
