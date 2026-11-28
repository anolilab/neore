/**
 * The remember tool: which message it names as the source, and the runs it never saves from.
 */
import { describe, expect, it, vi } from "vitest";

import { isGrantableKey } from "../lib/tool-permission-grants";
import { applyToolPermissions, resolveToolPermission, toolPermissionKey } from "../lib/tool-permissions";
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

    it("reads only the message that started the reply, and tells the model to ask for a mid-reply request again", () => {
        const tool = { ...rememberTool, ctx: contextWith({}) } as unknown as {
            description: string;
            toModelOutput: (options: { input: unknown; output: unknown; toolCallId: string }) => unknown;
        };
        const encoded = JSON.stringify(tool.toModelOutput({ input: {}, output: { facts: [], status: "nothing_asked" }, toolCallId: "call-1" }));

        expect(tool.description).toContain("the message that started this reply");
        expect(tool.description).toContain("ask them to send that as a new message");
        expect(encoded).toContain("A request they sent while you were replying is not read: ask them to send it as a new message.");
    });

    it("tells the model what was saved and which asked fact was refused and why", () => {
        const tool = { ...rememberTool, ctx: contextWith({}) } as unknown as {
            toModelOutput: (options: { input: unknown; output: unknown; toolCallId: string }) => unknown;
        };
        const encoded = JSON.stringify(
            tool.toModelOutput({
                input: {},
                output: { facts: [{ asked: false, memory: "User works as a nurse", status: "saved" }], refused: ["health"], status: "saved" },
                toolCallId: "call-1",
            }),
        );

        expect(encoded).toContain("User works as a nurse");
        expect(encoded).toContain("about their health");
        expect(encoded).toContain("Tell the user both what was saved and what was not");
    });
});

describe("remember's permissions", () => {
    const NOW = Date.UTC(2026, 10, 28, 12, 0, 0);
    const remember = { key: toolPermissionKey("builtin", "remember"), source: "builtin" as const };
    const tools = { remember: rememberTool } as never;

    it("takes an hour or today allow: a grant lifts its ask to auto until the grant ends", () => {
        const grants = { [remember.key]: NOW + 60_000 };

        expect(isGrantableKey(remember.key)).toBe(true);
        expect(resolveToolPermission(remember, { [remember.key]: "ask" }, { now: NOW, timedGrants: grants })).toBe("auto");
        expect(resolveToolPermission(remember, { [remember.key]: "ask" }, { now: NOW + 60_000, timedGrants: grants })).toBe("ask");
    });

    it("is removed from a run nobody is at, even when set to Auto", () => {
        const { removed, tools: kept } = applyToolPermissions(tools, () => undefined, { [remember.key]: "auto" }, { headless: true });

        expect(removed).toContain("remember");
        expect(Object.keys(kept)).not.toContain("remember");
    });
});
