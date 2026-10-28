/**
 * A worker's thread takes a turn only through `dispatchToWorker`: `/chat/start` (which the public
 * API's `POST /chat` and the MCP `send_message` tool both run) and `/chat/edit` answer 400 and
 * start nothing. The gate answer is faked; the refusal is what the entry points do with it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
    return { calls: [] as string[], isWorker: true };
});

vi.mock("../auth/lib/helper", () => {
    return {
        getCurrentUserInternal: async () => {
            return { _id: "user-a", isAnonymous: false };
        },
    };
});

vi.mock("../lib/thread-shard", () => {
    return { threadShardFor: async () => "user-a" };
});

vi.mock("../lib/http-shard", () => {
    return { inShard: async (ctx: unknown, _shard: string, run: (ctx: unknown) => Promise<Response>) => await run(ctx) };
});

const { runChatStart } = await import("./http");

const context = () =>
    ({
        auth: { getIdentity: async () => null },
        runMutation: async (reference: { __lunoraRef?: string }) => {
            state.calls.push(String(reference.__lunoraRef ?? reference));

            return null;
        },
        runQuery: async (reference: { __lunoraRef?: string }) => {
            const name = String(reference.__lunoraRef ?? reference);

            state.calls.push(name);

            if (name.includes("gateThreadAction")) {
                return { isWorker: state.isWorker, outcome: "ok" };
            }

            return null;
        },
    }) as never;

beforeEach(() => {
    state.calls = [];
    state.isWorker = true;
});

describe("runChatStart", () => {
    it("refuses a worker's thread with a 400 before spending anything", async () => {
        const response = await runChatStart(context(), { model: "anthropic/claude-sonnet-4", prompt: "hi", threadId: "thread-1" }, "secret");

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: expect.stringContaining("worker") });
        expect(state.calls.filter((name) => !name.includes("gateThreadAction") && !name.includes("getActiveOrganization"))).toStrictEqual([]);
    });

    it("refuses a regenerate in a worker's thread the same way", async () => {
        const response = await runChatStart(
            context(),
            { model: "anthropic/claude-sonnet-4", parentId: "message-1", prompt: "hi", regenerate: true, threadId: "thread-1" },
            "secret",
        );

        expect(response.status).toBe(400);
    });

    it("does not refuse an ordinary thread at the gate (control)", async () => {
        state.isWorker = false;

        const response = await runChatStart(context(), { model: "anthropic/claude-sonnet-4", prompt: "hi", threadId: "thread-1" }, "secret").catch(() => null);

        expect(response?.status).not.toBe(400);
    });
});
