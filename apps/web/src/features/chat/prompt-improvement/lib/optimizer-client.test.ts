/**
 * A refusal the backend answers with a 4xx (the user's model settings could not be read, or allow no model) is a
 * `ValidationError`, which the improvement hook throws at once; a 500 is a `ServerError`, which it retries.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ErrorUtilities, ServerError, ValidationError } from "@/lib/errors";

import { optimizeUserPromptRequest } from "./optimizer-client";

vi.mock("@/lib/env", () => {
    return { default: { VITE_LLM_GATEWAY_URL: "https://gateway.test" } };
});

const answer = (status: number, error: string) =>
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ error }, { status })),
    );

const failure = async (): Promise<Error> => {
    try {
        await optimizeUserPromptRequest({ prompt: "write a poem" });
    } catch (error) {
        return error as Error;
    }

    throw new Error("expected a failure");
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("optimizeUserPromptRequest", () => {
    it("does not retry a 400 refusal and keeps its message", async () => {
        answer(400, "Your model settings could not be read; try again.");

        const error = await failure();

        expect(error).toBeInstanceOf(ValidationError);
        expect(error.message).toBe("Your model settings could not be read; try again.");
        expect(ErrorUtilities.isRetryable(error)).toBe(false);
    });

    it("retries a 500", async () => {
        answer(500, "boom");

        const error = await failure();

        expect(error).toBeInstanceOf(ServerError);
        expect(ErrorUtilities.isRetryable(error)).toBe(true);
    });
});
