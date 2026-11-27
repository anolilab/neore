/**
 * The remember tool: which message it names as the source, and the runs it never saves from.
 */
import { describe, expect, it, vi } from "vitest";

import rememberTool from "./remember";

/** `wrapTools` attaches the agent's ctx to the tool object; `execute` reads it from there. */
const run = (context: unknown) =>
    (rememberTool as unknown as { execute: (input: unknown, options: unknown) => unknown }).execute.call({ ...rememberTool, ctx: context }, {}, {});

const contextWith = (extra: object) => {
    return {
        runAction: vi.fn(async () => {
            return { facts: [{ memory: "The user is vegan", status: "saved" }], status: "saved" };
        }),
        threadId: "thread-1",
        userId: "user-1",
        ...extra,
    };
};

describe("remember", () => {
    it("names the turn's own prompt, not the run's latest row, and the reply it belongs to", async () => {
        // A resumed or approved run points `promptMessageId` at its own last row; the turn records the prompt itself.
        const context = contextWith({
            promptMessageId: "last-row",
            replyKey: "stream-1",
            runTurn: { impersonated: false, promptMessageId: "prompt-1", systemContext: [] },
        });

        await expect(run(context)).resolves.toStrictEqual({ facts: [{ memory: "The user is vegan", status: "saved" }], status: "saved" });
        expect(context.runAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ promptMessageId: "prompt-1", replyKey: "stream-1" }));
    });

    it("saves nothing in a run nobody is at, or one that recorded no turn", async () => {
        const headless = contextWith({ headless: true, runTurn: { impersonated: false, promptMessageId: "prompt-1", systemContext: [] } });
        const noTurn = contextWith({});

        await expect(run(headless)).resolves.toStrictEqual({ facts: [], status: "not_private" });
        await expect(run(noTurn)).resolves.toStrictEqual({ facts: [], status: "not_private" });
        expect(headless.runAction).not.toHaveBeenCalled();
        expect(noTurn.runAction).not.toHaveBeenCalled();
    });
});
