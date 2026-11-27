/**
 * `startGeneration` saves the reply's pending row before it builds what the model is handed, and the caller only gets `fail`
 * once it returns: a failure in between must fail that row itself, or the reply stays pending with no error.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import startGeneration from "./start";

const mocks = vi.hoisted(() => {
    return {
        fetchContextWithPrompt: vi.fn(),
        saveInputMessages: vi.fn(),
        withApprovedToolModelOutputs: vi.fn(),
    };
});

vi.mock(import("./save-input-messages"), () => {
    return { default: mocks.saveInputMessages };
});

vi.mock(import("./search"), async (importOriginal) => {
    return { ...(await importOriginal()), fetchContextWithPrompt: mocks.fetchContextWithPrompt };
});

vi.mock(import("./tool-approval"), async (importOriginal) => {
    return { ...(await importOriginal()), withApprovedToolModelOutputs: mocks.withApprovedToolModelOutputs };
});

const MODEL = { modelId: "test-model", provider: "test", specificationVersion: "v3" };

const start = async () => {
    const runMutation = vi.fn(async () => null);
    const run = startGeneration(
        { runMutation, runQuery: vi.fn(async () => null), storage: {} } as never,
        {} as never,
        { model: MODEL, promptMessageId: "m1" } as never,
        { agentName: "agent", threadId: "thread-1", userId: "user-1" } as never,
    );

    return { run, runMutation };
};

beforeEach(() => {
    mocks.fetchContextWithPrompt.mockResolvedValue({
        approvedToolCallIds: ["call-1"],
        messages: [{ content: "the prompt", role: "user" }],
        order: 1,
        stepOrder: 0,
    });
    mocks.saveInputMessages.mockResolvedValue({
        pendingMessage: { _id: "pending-1", order: 1, stepOrder: 1 },
        promptMessageId: "m1",
        savedMessages: [],
    });
});

describe("startGeneration failing before the model call", () => {
    it("fails the pending row it saved, with an error the person sees, and rethrows", async () => {
        expect.assertions(3);

        mocks.withApprovedToolModelOutputs.mockRejectedValue(new Error("storage unavailable"));

        const { run, runMutation } = await start();

        await expect(run).rejects.toThrow("storage unavailable");
        expect(runMutation).toHaveBeenCalledTimes(1);
        expect(runMutation).toHaveBeenCalledWith(internal.agent.messages.finalizeMessage, {
            messageId: "pending-1",
            result: { error: expect.any(String), status: "failed" },
        });
    });

    it("leaves the pending row alone when the call is prepared", async () => {
        expect.assertions(2);

        mocks.withApprovedToolModelOutputs.mockImplementation(async (messages: unknown) => messages);

        const { run, runMutation } = await start();

        await expect(run).resolves.toHaveProperty("args.messages", [{ content: "the prompt", role: "user" }]);
        expect(runMutation).not.toHaveBeenCalled();
    });
});
