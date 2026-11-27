/**
 * The fence of a headless run (`headless-run.ts`): a tool call made once the fence has failed does not run, and a call made while it
 * holds does. The step boundary uses the same check as `shouldStop`.
 */
import { describe, expect, it, vi } from "vitest";

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
