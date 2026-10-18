/**
 * A PTY command on a bot thread runs on the bot's computer, and never closes or
 * kills it. Checked against a fake E2B and a fake action context.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import { runPtyCommand } from "./pty";

const { connectSandbox, createSandbox, kill, pause, run } = vi.hoisted(() => {
    return {
        connectSandbox: vi.fn(),
        createSandbox: vi.fn(),
        kill: vi.fn(),
        pause: vi.fn(),
        run: vi.fn(),
    };
});

vi.mock("e2b", () => {
    return { Sandbox: { connect: connectSandbox, create: createSandbox }, SandboxNotFoundError: class SandboxNotFoundError extends Error {} };
});
vi.mock("../env", () => {
    return { E2B_API_KEY: "test-key" };
});

const LIFETIME_MS = 60 * 60_000;

const fakeSandbox = { commands: { run }, kill, pause, sandboxId: "sbx-old" };

/** A bot thread whose bot has a computer, and a computer that is paused. */
const botContext = () => {
    const runMutation = vi.fn(async (ref: unknown) => {
        if (ref === internal.sandbox.functions.claimBotComputer) {
            return { created: false, sandboxId: "sbx-old", sessionId: "session-1", status: "paused" };
        }

        if (ref === internal.sandbox.functions.activateBotComputer) {
            return true;
        }

        return null;
    });

    const runQuery = vi.fn(async (ref: unknown) => {
        if (ref === internal.agent.threads.getThreadInternal) {
            return { botId: "bot-1" };
        }

        if (ref === internal.bots.functions.getBotForRun) {
            return { computerEnabled: true };
        }

        return null;
    });

    return { runMutation, runQuery, scheduler: { runAfter: vi.fn(async () => "fn-1") } };
};

beforeEach(() => {
    vi.clearAllMocks();
    connectSandbox.mockResolvedValue(fakeSandbox);
    run.mockResolvedValue({ exitCode: 0 });
});

describe("runPtyCommand on a bot thread", () => {
    it("attaches to the bot computer, resuming it with the lifetime cap", async () => {
        const context = botContext();

        const result = await runPtyCommand(context as never, {
            command: "ls",
            threadId: "thread-1" as never,
            userId: "user-1",
        });

        expect(connectSandbox).toHaveBeenCalledWith("sbx-old", { apiKey: "test-key", requestTimeoutMs: 20_000, timeoutMs: LIFETIME_MS });
        expect(createSandbox).not.toHaveBeenCalled();
        expect(run).toHaveBeenCalledWith("ls", expect.any(Object));
        expect(result).toMatchObject({ exitCode: 0 });
    });

    it("never kills, pauses, or marks the bot session terminated", async () => {
        const context = botContext();

        await runPtyCommand(context as never, {
            command: "ls",
            threadId: "thread-1" as never,
            userId: "user-1",
        });

        expect(kill).not.toHaveBeenCalled();
        expect(pause).not.toHaveBeenCalled();

        const closed = context.runMutation.mock.calls.filter(([ref]) => ref === internal.sandbox.functions.closeSession);

        expect(closed).toHaveLength(0);
    });
});
