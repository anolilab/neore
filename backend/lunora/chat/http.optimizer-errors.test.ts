/**
 * The optimizer endpoints refuse with a BAD_REQUEST when the user's model filters cannot be read or allow no model.
 * That refusal must reach the client as its own 4xx with the readable message: a 500 reads as transient, and the
 * web client retries it three times.
 */
import { LunoraError } from "lunorash/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../auth/lib/helper", () => {
    return {
        getCurrentUserInternal: async () => {
            return { _id: "user-a", plan: null };
        },
    };
});

const { improvePromptHttpAction, iteratePromptHttpAction, optimizeSystemPromptHttpAction } = await import("./http");

const REFUSAL = "Your model settings could not be read; try again.";

const post = (body: unknown) => new Request("https://x/chat/optimize", { body: JSON.stringify(body), method: "POST" });

const refusing = (error: unknown) =>
    ({
        runAction: vi.fn(async () => {
            throw error;
        }),
    }) as never;

const handlers = {
    improvePrompt: async (context: never) => await improvePromptHttpAction(context, post({ prompt: "write a poem" })),
    iteratePrompt: async (context: never) => await iteratePromptHttpAction(context, post({ iterateInput: "shorter", lastOptimizedPrompt: "write a poem" })),
    optimizeSystemPrompt: async (context: never) => await optimizeSystemPromptHttpAction(context, post({ prompt: "be helpful" })),
};

describe.each(Object.keys(handlers) as (keyof typeof handlers)[])("%s", (name) => {
    it("answers a BAD_REQUEST refusal with a 400 and its message", async () => {
        const response = await handlers[name](refusing(new LunoraError("BAD_REQUEST", REFUSAL)));

        expect(response.status).toBe(400);
        expect(await response.json()).toStrictEqual({ error: REFUSAL });
    });

    it("keeps an internal failure a 500 without its message", async () => {
        const response = await handlers[name](refusing(new LunoraError("INTERNAL_SERVER_ERROR", "db exploded")));

        expect(response.status).toBe(500);
        expect(JSON.stringify(await response.json())).not.toContain("db exploded");
    });
});
