/**
 * The bot computer's sandbox options, against a fake E2B. A resumed computer
 * must carry the lifetime cap, or E2B's 300 s default kills it on the next quiet
 * spell; a new one must pause at its cap rather than be killed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import { getOrCreateBotComputer } from "./sandbox-node";

const { createSandbox, connectSandbox } = vi.hoisted(() => ({
    connectSandbox: vi.fn(async (_id: string, _opts: unknown) => ({ sandboxId: "sbx-resumed" })),
    createSandbox: vi.fn(async (_opts: unknown) => ({ sandboxId: "sbx-new" })),
}));

vi.mock("e2b", () => ({ Sandbox: { connect: connectSandbox, create: createSandbox } }));
vi.mock("../../env", () => ({ E2B_API_KEY: "test-key" }));

const LIFETIME_MS = 60 * 60_000;

/** A context whose claim answers `claim`, and that records every mutation it is asked to run. */
const fakeContext = (claim: { created: boolean; sandboxId?: string; status: string }) => {
    const runMutation = vi.fn(async (ref: unknown) => {
        if (ref === internal.sandbox.functions.claimBotComputer) {
            return { ...claim, sessionId: "session-1" };
        }

        return null;
    });

    return {
        runMutation,
        scheduler: { runAfter: vi.fn(async () => "fn-1") },
    };
};

beforeEach(() => {
    createSandbox.mockClear();
    connectSandbox.mockClear();
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("getOrCreateBotComputer sandbox options", () => {
    it("creates a new computer that pauses at its lifetime cap instead of being killed", async () => {
        const context = fakeContext({ created: true, status: "starting" });

        await getOrCreateBotComputer(context, "user-1", "bot-1" as never);

        expect(createSandbox).toHaveBeenCalledWith({
            apiKey: "test-key",
            lifecycle: { autoResume: false, onTimeout: "pause" },
            timeoutMs: LIFETIME_MS,
        });
    });

    it("resumes a paused computer with the lifetime cap, not E2B's 300 s default", async () => {
        const context = fakeContext({ created: false, sandboxId: "sbx-old", status: "paused" });

        await getOrCreateBotComputer(context, "user-1", "bot-1" as never);

        expect(connectSandbox).toHaveBeenCalledWith("sbx-old", { apiKey: "test-key", timeoutMs: LIFETIME_MS });
        expect(createSandbox).not.toHaveBeenCalled();
    });
});
