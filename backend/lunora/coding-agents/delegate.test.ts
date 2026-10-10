import { describe, expect, it, vi } from "vitest";

import type { DelegationDependencies } from "./delegate";
import { delegateToCodingAgent } from "./delegate";

const input = { agent: "claude_code" as const, repository: "anolilab/neore", task: "Fix the flaky test" };
const context = { threadId: "thread1", toolCallId: "call1", userId: "user1" };

const dependencies = (overrides: Partial<DelegationDependencies> = {}): DelegationDependencies => {
    return {
        createRun: vi.fn(async () => {
            return { runId: "run1" };
        }),
        hasProviderKey: vi.fn(async () => true),
        ...overrides,
    };
};

describe("delegateToCodingAgent (the chat tool's async hand-off)", () => {
    it("creates the run and returns at once with its id — it never waits for the run", async () => {
        const stubs = dependencies();
        const result = await delegateToCodingAgent(input, context, stubs);

        expect(result).toMatchObject({ runId: "run1", status: "started" });
        expect(stubs.createRun).toHaveBeenCalledOnce();
        expect(stubs.createRun).toHaveBeenCalledWith({
            agent: "claude_code",
            openPr: false,
            prompt: "Fix the flaky test",
            repoUrl: "anolilab/neore",
            threadId: "thread1",
            toolCallId: "call1",
            userId: "user1",
        });
    });

    it("tells the model the result arrives later and not to claim it", async () => {
        const result = await delegateToCodingAgent(input, context, dependencies());

        expect(result.status === "started" && result.message).toContain("posted to this conversation");
        expect(result.status === "started" && result.message).toContain("Do not wait");
    });

    it("passes an explicit PR request and branch through", async () => {
        const stubs = dependencies();

        await delegateToCodingAgent({ ...input, branch: "dev", openPullRequest: true }, context, stubs);

        expect(stubs.createRun).toHaveBeenCalledWith(expect.objectContaining({ branch: "dev", openPr: true }));
    });

    it("refuses before creating anything when the user has no provider key", async () => {
        const stubs = dependencies({ hasProviderKey: vi.fn(async () => false) });
        const result = await delegateToCodingAgent({ ...input, agent: "codex" }, context, stubs);

        expect(result).toEqual({ error: expect.stringContaining("OpenAI API key"), status: "failed" });
        expect(stubs.hasProviderKey).toHaveBeenCalledWith({ provider: "openai", userId: "user1" });
        expect(stubs.createRun).not.toHaveBeenCalled();
    });

    it("reports an admission refusal (one run at a time, rate limit) as a failure", async () => {
        const stubs = dependencies({
            createRun: vi.fn(async () => {
                return { error: "A coding agent is already running for you." };
            }),
        });

        expect(await delegateToCodingAgent(input, context, stubs)).toEqual({ error: "A coding agent is already running for you.", status: "failed" });
    });

    it("requires a signed-in user", async () => {
        const stubs = dependencies();

        const result = await delegateToCodingAgent(input, { toolCallId: "call1" }, stubs);

        expect(result.status).toBe("failed");
        expect(stubs.createRun).not.toHaveBeenCalled();
    });
});
