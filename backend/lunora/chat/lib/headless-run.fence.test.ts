/**
 * The fence of a headless run (`headless-run.ts`): a tool call made once the fence has failed does not run, and a call made while it
 * holds does. The step boundary uses the same check as `shouldStop`.
 */
import { describe, expect, it, vi } from "vitest";
import z from "zod/v4";

import { createTool, wrapTools } from "../../agent/client/create-tool";
import { FencedRunError, fenceTools } from "./headless-run";

const tool = () => {
    const execute = vi.fn(async (input: unknown) => {
        return { echoed: input };
    });

    return { execute, tool: { description: "t", execute } };
};

describe("fenceTools", () => {
    it("runs a call while the fence holds, and refuses one after it failed, without running it", async () => {
        const { execute, tool: wrapped } = tool();
        let holds = true;
        const fenced = fenceTools({ read: wrapped }, async () => holds) as unknown as { read: { execute: (input: unknown) => Promise<unknown> } };

        await expect(fenced.read.execute("a")).resolves.toEqual({ echoed: "a" });
        expect(execute).toHaveBeenCalledTimes(1);

        holds = false;
        await expect(fenced.read.execute("b")).rejects.toBeInstanceOf(FencedRunError);
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it("leaves a tool that does not execute as it is", () => {
        const passive = { description: "no execute" };
        const fenced = fenceTools({ passive }, async () => false);

        expect(fenced.passive).toBe(passive);
    });
});

describe("fenceTools on a tool made by createTool", () => {
    it("runs the tool through the run's context binding while the fence holds, and refuses a call after it fails before execute runs", async () => {
        const seen: { input: unknown; userId?: string }[] = [];
        const read = createTool<{ number: number }, object>({
            description: "reads",
            execute: async (context, input) => {
                seen.push({ input, userId: context.userId });

                return { read: input.number };
            },
            inputSchema: z.object({ number: z.number() }),
        });
        let holds = true;
        // As the run does it: the fence first, then `wrapTools` puts the run's context on its copy of each tool.
        const tools = wrapTools(
            { userId: "owner" } as never,
            fenceTools({ readPullRequest: read }, async () => holds),
        ) as unknown as {
            readPullRequest: { execute: (input: unknown, options: unknown) => Promise<unknown> };
        };

        await expect(tools.readPullRequest.execute({ number: 7 }, { messages: [], toolCallId: "c1" })).resolves.toEqual({ read: 7 });
        expect(seen).toEqual([{ input: { number: 7 }, userId: "owner" }]);

        holds = false;
        await expect(tools.readPullRequest.execute({ number: 8 }, { messages: [], toolCallId: "c2" })).rejects.toBeInstanceOf(FencedRunError);
        expect(seen).toHaveLength(1);
    });
});
