/**
 * `/prompts/optimize` resolves the caller on the HTTP side and hands the action
 * their id. It used to read `identity.subject` inside an internal action — which
 * `resolveIdentity` never sets — so every call, signed in or not, answered
 * "must be logged in".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import optimizePromptHttpAction from "./http";

const currentUser = vi.hoisted(() => {
    return { value: undefined as { _id: string } | undefined };
});

vi.mock("../auth/lib/helper", () => {
    return {
        getCurrentUserInternal: async () => currentUser.value,
    };
});

const post = (body: unknown) => new Request("https://x/prompts/optimize", { body: JSON.stringify(body), method: "POST" });

describe("/prompts/optimize", () => {
    let runAction: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        runAction = vi.fn(async () => {
            return { improvedPrompt: "better" };
        });
    });

    it("refuses an unauthenticated caller without running the optimizer", async () => {
        currentUser.value = undefined;

        const response = await optimizePromptHttpAction({ runAction } as never, post({ content: "write a poem" }));

        expect(response.status).toBe(401);
        expect(runAction).not.toHaveBeenCalled();
    });

    it("runs the optimizer for a signed-in caller, as that caller", async () => {
        currentUser.value = { _id: "user-1" };

        const response = await optimizePromptHttpAction({ runAction } as never, post({ content: "write a poem" }));

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ improvedPrompt: "better" });
        expect(runAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ content: "write a poem", userId: "user-1" }));
    });
});
