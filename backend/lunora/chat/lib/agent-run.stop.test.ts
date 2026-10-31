/**
 * A sidebar stop that lands on a run's chunk write. The reply the run still owed is saved and
 * only then is the model call aborted. A refusal that is not a stop, or a stop with nothing to
 * end, is rethrown as it was. Covers the main run's final write and a resumed continuation.
 */
import { LunoraError } from "lunorash/server";
import { describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import { endStoppedRun, finishRun, resumeApprovedRun } from "./agent-run";
import { buildAgentTools } from "./agent-tools";
import getAgent from "./get-agent";
import { pipeToPersistentChunks, streamWriteRefused } from "./persist-stream";

// The continuation builds its agent and tools here; the test drives the stream it gets back.
vi.mock("./get-agent", () => {
    return { default: vi.fn() };
});
vi.mock("./agent-tools", () => {
    return {
        buildAgentTools: vi.fn(async () => {
            return { mcpClients: [], mcpLabels: {}, mcpServerNames: [], permissionKeys: {}, tools: {} };
        }),
    };
});

/** The continuation's first step: one text delta, which the pipe writes at once. */
async function* resumedStream() {
    yield { text: "Resumed reply.", type: "text-delta" };
}

const conflict = () => new LunoraError("CONFLICT", "Stream is not streaming; did it timeout?");

/** A context whose chunk writes are refused as a stop, and which records the stop's reply. */
const stoppedCtx = (saved: boolean) => {
    const mutations: { args: Record<string, unknown>; ref: unknown }[] = [];
    const ctx = {
        runMutation: vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
            mutations.push({ args, ref });

            if (ref === internal.chat.streaming.persistent.library.addChunk) {
                throw conflict();
            }

            if (ref === internal.chat.streaming.persistent.library.finishStoppedReply) {
                return { messageId: saved ? "stopped-1" : undefined, stopped: saved };
            }

            return null;
        }),
    };

    return { ctx, mutations };
};

const STOP_ARGS = {
    continuation: false,
    order: 1,
    promptMessageId: "prompt-1",
    result: { consumeStream: async () => undefined },
    stop: new AbortController(),
    streamId: "stream-1",
    threadId: "thread-1",
};

describe("a stop during a long tool step", () => {
    it("is found while the run writes nothing, the reply is saved as stopped, and the tool's signal is aborted", async () => {
        const mutations: { args: Record<string, unknown>; ref: unknown }[] = [];
        const ctx = {
            runMutation: vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
                mutations.push({ args, ref });

                return ref === internal.chat.streaming.persistent.library.finishStoppedReply ? { messageId: "stopped-1", stopped: true } : null;
            }),
            runQuery: vi.fn(async () => "done"),
        };
        const stop = new AbortController();
        const toolEnded = { aborted: false };
        // The model wrote some text and is now inside a tool call that only ends when the run's signal aborts.
        const fullStream = (async function* quietTool() {
            yield { text: "Searching. ", type: "text-delta" };
            await new Promise<void>((resolve) => {
                stop.signal.addEventListener("abort", () => resolve(), { once: true });
            });
            toolEnded.aborted = true;
        })();
        const error = await pipeToPersistentChunks(ctx as never, "stream-1", fullStream, { stopPollMs: 10 }).catch((error_: unknown) => error_);
        const saved = await endStoppedRun(ctx as never, error, { ...STOP_ARGS, result: { consumeStream: async () => undefined }, stop });

        expect(saved).toStrictEqual(["stopped-1"]);
        const stoppedReply = mutations.find((call) => call.ref === internal.chat.streaming.persistent.library.finishStoppedReply);

        expect(stoppedReply?.args).toMatchObject({ pendingText: "Searching. " });
        expect(stop.signal.aborted).toBe(true);
        await vi.waitFor(() => expect(toolEnded.aborted).toBe(true));
    });
});

describe(endStoppedRun, () => {
    it("saves the owed text of a refused write, then aborts the model call", async () => {
        const { ctx, mutations } = stoppedCtx(true);
        const stop = new AbortController();

        await endStoppedRun(ctx as never, streamWriteRefused({ reasoning: "", text: "Hello." }, conflict()), { ...STOP_ARGS, stop });

        // The reply is saved first; the thread's secret references go once the stopped reply is written.
        expect(mutations.map((call) => call.ref)).toStrictEqual([
            internal.chat.streaming.persistent.library.finishStoppedReply,
            internal.chat.request_secret.discardSecretsOfThread,
        ]);
        expect(mutations[0]?.args).toMatchObject({ continuation: false, order: 1, pendingText: "Hello.", promptMessageId: "prompt-1" });
        expect(stop.signal.aborted).toBe(true);
    });

    it("returns the row it saved, and drains the aborted result only after the abort", async () => {
        const { ctx } = stoppedCtx(true);
        const stop = new AbortController();
        const drained: boolean[] = [];

        const saved = await endStoppedRun(ctx as never, streamWriteRefused({ reasoning: "", text: "Hello." }, conflict()), {
            ...STOP_ARGS,
            result: {
                consumeStream: async () => {
                    drained.push(stop.signal.aborted);
                },
            },
            stop,
        });

        expect(saved).toStrictEqual(["stopped-1"]);
        expect(drained).toStrictEqual([true]);
    });

    it("a rejected save still aborts the model call and drains the result, then rethrows the save's error", async () => {
        const rejected = new Error("owed text too large");
        const stop = new AbortController();
        const drained: boolean[] = [];
        const ctx = {
            runMutation: async () => {
                throw rejected;
            },
        };

        await expect(
            endStoppedRun(ctx as never, streamWriteRefused({ reasoning: "", text: "Hello." }, conflict()), {
                ...STOP_ARGS,
                result: {
                    consumeStream: async () => {
                        drained.push(stop.signal.aborted);
                    },
                },
                stop,
            }),
        ).rejects.toBe(rejected);
        expect(stop.signal.aborted).toBe(true);
        expect(drained).toStrictEqual([true]);
    });

    it("rethrows the original error when nothing was stopped, and does not abort", async () => {
        const { ctx } = stoppedCtx(false);
        const stop = new AbortController();
        const error = conflict();

        await expect(endStoppedRun(ctx as never, streamWriteRefused({ reasoning: "", text: "" }, error), { ...STOP_ARGS, stop })).rejects.toBe(error);
        expect(stop.signal.aborted).toBe(false);
    });

    it("rethrows an error that is not a refused write, without saving anything", async () => {
        const { ctx, mutations } = stoppedCtx(true);
        const boom = new Error("database down");

        await expect(endStoppedRun(ctx as never, boom, STOP_ARGS)).rejects.toBe(boom);
        expect(mutations).toHaveLength(0);
    });
});

describe(finishRun, () => {
    const runArgs = {
        mcpLabels: {},
        savedMessages: [],
        snapshot: {} as never,
        streamId: "stream-1",
        threadId: "thread-1",
        userId: "owner-1",
    };

    it("a stop that ends the stream before the final write refuses it, owing the unsaved text and the final buffer", async () => {
        const { ctx } = stoppedCtx(true);

        const error = await finishRun(ctx as never, {
            ...runArgs,
            pending: { reasoning: "", text: "world." },
            unsaved: { reasoning: "", text: "Hello " },
        }).catch((error_: unknown) => error_);

        expect(error).toMatchObject({ pending: { reasoning: "", text: "Hello world." } });
    });

    it("a genuine write failure is rethrown as it was, not as a stop", async () => {
        const boom = new Error("database down");
        const ctx = {
            runMutation: vi.fn(async () => {
                throw boom;
            }),
        };

        await expect(finishRun(ctx as never, { ...runArgs, pending: { reasoning: "", text: "x" } })).rejects.toBe(boom);
    });

    it("a normal finish writes its final chunk and reports no pause", async () => {
        const ctx = { runMutation: vi.fn(async () => null) };

        await expect(finishRun(ctx as never, { ...runArgs, pending: { reasoning: "", text: "x" } })).resolves.toStrictEqual({ paused: false });
        expect(ctx.runMutation).toHaveBeenCalledWith(internal.chat.streaming.persistent.library.addChunk, expect.objectContaining({ final: true }));
    });

    it("a final end drops that reply's saved secret references, and a failing drop does not fail the run", async () => {
        const ctx = {
            runMutation: vi.fn(async (ref: unknown) => {
                if (ref === internal.chat.request_secret.discardSecretsOfThread) {
                    throw new Error("shard busy");
                }

                return null;
            }),
        };

        await expect(finishRun(ctx as never, { ...runArgs, pending: { reasoning: "", text: "x" } })).resolves.toStrictEqual({ paused: false });
        expect(ctx.runMutation).toHaveBeenCalledWith(internal.chat.request_secret.discardSecretsOfThread, { streamId: "stream-1", threadId: "thread-1" });
    });

    it("a pause keeps them (a consumer set to ask resumes the run), and so does a group turn that goes on to its next speaker", async () => {
        const ctx = { runMutation: vi.fn(async () => null) };
        const paused = {
            ...runArgs,
            pending: { reasoning: "", text: "x" },
            savedMessages: [{ _id: "m1", message: { content: [{ approvalId: "a1", toolCallId: "c1", type: "tool-approval-request" }], role: "assistant" } }],
        };

        await expect(finishRun(ctx as never, paused)).resolves.toStrictEqual({ paused: true });
        await expect(finishRun(ctx as never, { ...runArgs, keepOpenUnlessPaused: true, pending: { reasoning: "", text: "x" } })).resolves.toStrictEqual({
            paused: false,
        });
        expect(ctx.runMutation).not.toHaveBeenCalledWith(internal.chat.request_secret.discardSecretsOfThread, expect.anything());
    });

    it("a stop that ends the reply drops them too, with the thread and stream it names", async () => {
        const { ctx, mutations } = stoppedCtx(true);

        await endStoppedRun(ctx as never, streamWriteRefused({ reasoning: "", text: "Hello." }, conflict()), { ...STOP_ARGS, stop: new AbortController() });

        expect(mutations.find((call) => call.ref === internal.chat.request_secret.discardSecretsOfThread)?.args).toStrictEqual({
            streamId: "stream-1",
            threadId: "thread-1",
        });
    });
});

describe(resumeApprovedRun, () => {
    it("a stop during a continuation saves its reply at the continuation's order and aborts the resumed call", async () => {
        const { ctx, mutations } = stoppedCtx(true);
        const pending = { approvalId: "approval-1", toolName: null };

        // The approval is open, so the continuation runs; its first step writes text and is stopped.
        const runQuery = vi.fn(async (ref: unknown) => {
            if (ref === internal.chat.tool_permissions.getPendingToolApproval) {
                return pending;
            }

            if (ref === internal.auth.functions.getUserPreferencesQuery) {
                return {};
            }

            return ref === internal.auth.functions.getDecryptedProviderKeysQuery ? {} : null;
        });
        const runCtx = { runMutation: ctx.runMutation, runQuery };
        let streamArgs: { abortSignal?: AbortSignal } = {};
        const agent = {
            approveToolCall: vi.fn(async (_ctx: unknown, _ids: unknown, _approval: unknown, args: { abortSignal?: AbortSignal }) => {
                streamArgs = args;

                return {
                    consumeStream: async () => {},
                    fullStream: resumedStream(),
                    order: 2,
                    promptMessageId: "tool-result-1",
                    savedMessages: [],
                };
            }),
            options: {},
        };

        vi.mocked(getAgent).mockResolvedValue(agent as never);
        vi.mocked(buildAgentTools).mockClear();

        const result = await resumeApprovedRun(
            runCtx as never,
            {
                approvalId: "approval-1",
                approved: true,
                config: { autoMediaEnrichment: false, mcpServerNames: [], model: "gpt-4o", searchMode: "chat", toolNames: [] } as never,
                streamId: "stream-1",
                threadId: "thread-1",
                userId: "owner-1",
            },
            { agentName: "Reviewer" },
        );

        expect(result).toStrictEqual({ lastMessageId: undefined, paused: false, stopped: true });
        expect(streamArgs.abortSignal?.aborted).toBe(true);

        const reply = mutations.find((mutation) => mutation.ref === internal.chat.streaming.persistent.library.finishStoppedReply);

        expect(reply?.args).toMatchObject({
            agentName: "Reviewer",
            continuation: true,
            order: 2,
            pendingText: "Resumed reply.",
            promptMessageId: "tool-result-1",
        });
    });
    it("records the usage of each reply a steered continuation saved", async () => {
        const runAfter = vi.fn(async () => "job");
        const runMutation = vi.fn(async () => null);
        const runQuery = vi.fn(async (ref: unknown) => {
            if (ref === internal.chat.tool_permissions.getPendingToolApproval) {
                return { approvalId: "approval-1", toolName: null };
            }

            if (ref === internal.auth.functions.getUserPreferencesQuery) {
                return { timezone: "Pacific/Auckland" };
            }

            return ref === internal.auth.functions.getDecryptedProviderKeysQuery ? {} : null;
        });
        const row = (id: string, order: number, role: string) => {
            return { _id: id, message: { content: "x", role }, order, usage: { totalTokens: 10 } };
        };
        const agent = {
            approveToolCall: vi.fn(async () => {
                return {
                    consumeStream: async () => {},
                    fullStream: (async function* none() {})(),
                    order: 2,
                    promptMessageId: "tool-result-1",
                    savedMessages: [row("r1", 2, "assistant"), row("steer", 3, "user"), row("r2", 3, "assistant")],
                };
            }),
            options: {},
        };

        vi.mocked(getAgent).mockResolvedValue(agent as never);
        // 23:30 UTC on the 24th is already the 25th in Auckland.
        vi.useFakeTimers({ now: Date.UTC(2026, 9, 24, 23, 30), toFake: ["Date"] });

        await resumeApprovedRun(
            { runMutation, runQuery, scheduler: { runAfter } } as never,
            {
                approvalId: "approval-1",
                approved: true,
                config: { autoMediaEnrichment: false, mcpServerNames: [], model: "gpt-4o", searchMode: "chat", toolNames: [] } as never,
                streamId: "stream-1",
                threadId: "thread-1",
                userId: "owner-1",
            },
            { steerable: true },
        );

        vi.useRealTimers();

        const recorded = runAfter.mock.calls.filter((call) => (call as unknown[])[1] === internal.usage.activity.recordReplyUsage);

        expect(recorded.map((call) => (call as unknown[])[2])).toMatchObject([
            { date: "2026-10-25", replyKey: "r1", tokens: 10 },
            { date: "2026-10-25", replyKey: "r2", tokens: 10 },
        ]);
    });
});
