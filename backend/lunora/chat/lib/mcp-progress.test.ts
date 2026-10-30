/**
 * The throttle is pure (time and timers are injected); the writer and the transport hook are driven
 * through it and through a real `@ai-sdk/mcp` client over a fake transport.
 */
import { createMCPClient } from "@ai-sdk/mcp";
import type { MCPTransport } from "@ai-sdk/mcp";
import { describe, expect, it, vi } from "vitest";

import {
    createLatestThrottle,
    createProgressCall,
    createToolProgressWriter,
    readProgressParams,
    runWithProgressCall,
    sanitizeProgressMessage,
} from "./mcp-progress";
import type { McpProgress, ToolProgressChunk } from "./mcp-progress";
import { attachProgressTokens } from "./mcp-progress-transport";

/** A clock and timer queue the test advances by hand. */
const fakeClock = () => {
    let time = 1000;
    let nextId = 0;
    const timers = new Map<number, { at: number; run: () => void }>();

    return {
        advance: async (ms: number) => {
            const end = time + ms;

            for (;;) {
                const due = [...timers].filter(([, timer]) => timer.at <= end).toSorted(([, a], [, b]) => a.at - b.at)[0];

                if (!due) {
                    break;
                }

                timers.delete(due[0]);
                time = due[1].at;
                due[1].run();
                await Promise.resolve();
                await Promise.resolve();
            }

            time = end;

            for (let i = 0; i < 10; i += 1) {
                await Promise.resolve();
            }
        },
        clearTimer: (id: unknown) => {
            timers.delete(id as number);
        },
        now: () => time,
        pending: () => timers.size,
        setTimer: (run: () => void, ms: number) => {
            nextId += 1;
            timers.set(nextId, { at: time + ms, run });

            return nextId;
        },
    };
};

describe(readProgressParams, () => {
    it("reads progress, total and message", () => {
        expect(readProgressParams({ message: "Indexing", progress: 3, progressToken: "t", total: 10 })).toStrictEqual({
            message: "Indexing",
            progress: 3,
            total: 10,
        });
    });

    it("treats a missing, zero or non-finite total as unknown", () => {
        expect(readProgressParams({ progress: 1 })).toStrictEqual({ progress: 1 });
        expect(readProgressParams({ progress: 1, total: 0 })).toStrictEqual({ progress: 1 });
        expect(readProgressParams({ progress: 1, total: Infinity })).toStrictEqual({ progress: 1 });
        expect(readProgressParams({ progress: 1, total: -4 })).toStrictEqual({ progress: 1 });
    });

    it("drops a report with no usable progress", () => {
        expect(readProgressParams({ progress: NaN })).toBeUndefined();
        expect(readProgressParams({ progress: -1 })).toBeUndefined();
        expect(readProgressParams({ progress: "3" })).toBeUndefined();
        expect(readProgressParams(null)).toBeUndefined();
    });

    it("cuts a long message and drops a blank one", () => {
        expect(readProgressParams({ message: "x".repeat(5000), progress: 1 })?.message).toHaveLength(200);
        expect(readProgressParams({ message: " ".repeat(3), progress: 1 })).toStrictEqual({ progress: 1 });
    });

    it("sanitises the untrusted message", () => {
        expect(readProgressParams({ message: "\u{202E}evil\u{202C}\u{2066}x\u{2069}", progress: 1 })?.message).toBe("evilx");
        expect(readProgressParams({ message: "\u{202E}\u{2066}", progress: 1 })).toStrictEqual({ progress: 1 });
    });
});

describe(sanitizeProgressMessage, () => {
    it("removes control characters and bidi overrides and isolates", () => {
        expect(sanitizeProgressMessage("a\u{0}b\u{7}c\u{7F}d\u{9F}e")).toBe("abcde");

        for (const code of [0x20_2a, 0x20_2b, 0x20_2c, 0x20_2d, 0x20_2e, 0x20_66, 0x20_67, 0x20_68, 0x20_69]) {
            expect(sanitizeProgressMessage(`a${String.fromCodePoint(code)}b`)).toBe("ab");
        }
    });

    it("keeps words apart where a line break or tab was", () => {
        expect(sanitizeProgressMessage("page 1\r\npage\t2")).toBe("page 1 page 2");
    });

    it("cuts by code point, so a surrogate pair is never split", () => {
        const text = sanitizeProgressMessage("😀".repeat(300));

        expect([...text]).toHaveLength(200);
        expect(text).toBe("😀".repeat(200));
    });
});

describe(createLatestThrottle, () => {
    it("sends the first value at once", () => {
        const clock = fakeClock();
        const emit = vi.fn();
        const throttle = createLatestThrottle<number>(emit, clock);

        throttle.push(1);

        expect(emit).toHaveBeenCalledExactlyOnceWith(1);
    });

    it("keeps only the latest of a burst and sends it when the interval is over", async () => {
        const clock = fakeClock();
        const emit = vi.fn();
        const throttle = createLatestThrottle<number>(emit, clock);

        throttle.push(1);
        await Promise.resolve();
        await Promise.resolve();
        await clock.advance(100);
        throttle.push(2);
        // eslint-disable-next-line unicorn/prefer-single-call -- the throttle's own push, one value per call, not Array#push
        throttle.push(3);
        // eslint-disable-next-line unicorn/prefer-single-call -- the throttle's own push, one value per call, not Array#push
        throttle.push(4);
        await clock.advance(399);

        expect(emit.mock.calls).toStrictEqual([[1]]);

        await clock.advance(1);

        expect(emit.mock.calls).toStrictEqual([[1], [4]]);
    });

    it("sends at most one value per interval however long the burst runs", async () => {
        const clock = fakeClock();
        const emit = vi.fn();
        const throttle = createLatestThrottle<number>(emit, clock);

        for (let i = 0; i < 100; i += 1) {
            throttle.push(i);
            await clock.advance(50);
        }

        // 100 pushes over 5 seconds: the first at once, then one per 500 ms.
        expect(emit.mock.calls.length).toBeGreaterThanOrEqual(9);
        expect(emit.mock.calls.length).toBeLessThanOrEqual(11);
    });

    it("sends nothing after close and clears its timer", async () => {
        const clock = fakeClock();
        const emit = vi.fn();
        const throttle = createLatestThrottle<number>(emit, clock);

        throttle.push(1);
        await Promise.resolve();
        await Promise.resolve();
        throttle.push(2);

        expect(clock.pending()).toBe(1);

        await throttle.close();
        await clock.advance(5000);
        throttle.push(3);

        expect(emit.mock.calls).toStrictEqual([[1]]);
        expect(clock.pending()).toBe(0);
    });

    it("does not start a value while the previous write is still running, and close waits for it", async () => {
        const clock = fakeClock();
        const release: (() => void)[] = [];
        const emit = vi.fn(
            async () =>
                await new Promise<void>((resolve) => {
                    release.push(resolve);
                }),
        );
        const throttle = createLatestThrottle<number>(emit, clock);

        throttle.push(1);
        // eslint-disable-next-line unicorn/prefer-single-call -- the throttle's own push, one value per call, not Array#push
        throttle.push(2);
        await clock.advance(2000);

        expect(emit).toHaveBeenCalledTimes(1);

        let closed = false;
        const closing = throttle.close().then(() => {
            closed = true;

            return undefined;
        });

        await Promise.resolve();

        expect(closed).toBe(false);

        release[0]?.();
        await closing;

        expect(closed).toBe(true);
        expect(emit).toHaveBeenCalledTimes(1);
    });

    it("keeps going after a failed write", async () => {
        const clock = fakeClock();
        const emit = vi.fn().mockRejectedValueOnce(new Error("refused")).mockResolvedValue(undefined);
        const throttle = createLatestThrottle<number>(emit, clock);

        throttle.push(1);
        await clock.advance(1);
        throttle.push(2);
        await clock.advance(500);

        expect(emit.mock.calls).toStrictEqual([[1], [2]]);
    });
});

describe(sanitizeProgressMessage, () => {
    it("cuts a huge message down before cleaning it, and still returns at most the cap", () => {
        const huge = "a\u{202E}".repeat(1_000_000);

        expect([...sanitizeProgressMessage(huge)]).toHaveLength(200);
    });
});

describe(createToolProgressWriter, () => {
    const tool = { serverName: "Docs", toolCallId: "call_1", toolName: "index" };

    it("cleans the server and tool names it writes, which come from the MCP server", async () => {
        const clock = fakeClock();
        const write = vi.fn(async (_chunk: ToolProgressChunk) => {});
        const call = createToolProgressWriter(write, clock)({ serverName: "Do\u{202E}cs", toolCallId: "call_1", toolName: "in\u{7}dex" });

        call.push({ progress: 1 });
        await call.finish();

        expect(write.mock.calls[0]?.[0]).toMatchObject({ serverName: "Docs", toolName: "index" });
    });

    it("writes nothing for a call that never reported progress", async () => {
        const write = vi.fn(async (_chunk: ToolProgressChunk) => {});
        const call = createToolProgressWriter(write, fakeClock())(tool);

        await call.finish();

        expect(write).not.toHaveBeenCalled();
    });

    it("writes the reports, then one ended marker, and nothing after it", async () => {
        const clock = fakeClock();
        const write = vi.fn(async (_chunk: ToolProgressChunk) => {});
        const call = createToolProgressWriter(write, clock)(tool);

        call.push({ message: "start", progress: 0, total: 4 });
        await clock.advance(1);
        call.push({ progress: 1, total: 4 });
        // eslint-disable-next-line unicorn/prefer-single-call -- the progress call's own push, one value per call, not Array#push
        call.push({ progress: 2, total: 4 });
        await call.finish();
        await clock.advance(5000);

        expect(write.mock.calls.map(([chunk]) => chunk)).toStrictEqual([
            { ...tool, message: "start", progress: 0, total: 4 },
            { ...tool, ended: true },
        ]);
    });

    it("never fails the tool when the stream refuses a write", async () => {
        const clock = fakeClock();
        const write = vi.fn(async (_chunk: ToolProgressChunk) => {
            throw new Error("Stream write refused");
        });
        const call = createToolProgressWriter(write, clock)(tool);

        call.push({ progress: 1 });
        await clock.advance(1);

        await expect(call.finish()).resolves.toBeUndefined();
    });

    it("stops writing once the stream refuses a write, the ended marker included", async () => {
        const clock = fakeClock();
        const write = vi.fn(async (_chunk: ToolProgressChunk) => {
            throw new Error("Stream write refused");
        });
        const call = createToolProgressWriter(write, clock)(tool);

        call.push({ progress: 1 });
        await clock.advance(600);
        call.push({ progress: 2 });
        await clock.advance(600);
        call.push({ progress: 3 });
        await clock.advance(600);
        await call.finish();

        expect(write).toHaveBeenCalledTimes(1);
    });

    it("skips a write that repeats the last one for the call", async () => {
        const clock = fakeClock();
        const write = vi.fn(async (_chunk: ToolProgressChunk) => {});
        const call = createToolProgressWriter(write, clock)(tool);

        call.push({ message: "page", progress: 1, total: 4 });
        await clock.advance(600);
        call.push({ message: "page", progress: 1, total: 4 });
        await clock.advance(600);
        call.push({ message: "page", progress: 2, total: 4 });
        await clock.advance(600);
        call.push({ message: "page", progress: 2, total: 4 });
        await clock.advance(600);
        call.push({ message: "other", progress: 2, total: 4 });
        await clock.advance(600);
        await call.finish();

        expect(write.mock.calls.map(([chunk]) => chunk)).toStrictEqual([
            { ...tool, message: "page", progress: 1, total: 4 },
            { ...tool, message: "page", progress: 2, total: 4 },
            { ...tool, message: "other", progress: 2, total: 4 },
            { ...tool, ended: true },
        ]);
    });

    it("writes at most every 500 ms at first, and every 2 s once the call has run a minute", async () => {
        const clock = fakeClock();
        const write = vi.fn(async (_chunk: ToolProgressChunk) => {});
        const call = createToolProgressWriter(write, clock)(tool);

        call.push({ progress: 1 });
        await clock.advance(1);
        call.push({ progress: 2 });
        await clock.advance(499);

        expect(write).toHaveBeenCalledTimes(2);

        await clock.advance(60_000);
        call.push({ progress: 3 });
        await clock.advance(1);
        call.push({ progress: 4 });
        await clock.advance(1000);

        expect(write).toHaveBeenCalledTimes(3);

        await clock.advance(1000);

        expect(write).toHaveBeenCalledTimes(4);
        expect(write.mock.calls.at(-1)?.[0].progress).toBe(4);
    });

    it("past 300 reports slows a call to one every 30 s instead of freezing its bar", async () => {
        const clock = fakeClock();
        const write = vi.fn(async (_chunk: ToolProgressChunk) => {});
        const call = createToolProgressWriter(write, clock)(tool);

        for (let i = 1; i <= 320; i += 1) {
            call.push({ progress: i });
            await clock.advance(2000);
        }

        const atCap = write.mock.calls.length;

        // A further minute of reports adds about two rows, not thirty.
        for (let i = 321; i <= 350; i += 1) {
            call.push({ progress: i });
            await clock.advance(2000);
        }

        await call.finish();

        const reports = write.mock.calls.map(([chunk]) => chunk).filter((chunk) => chunk.progress !== undefined);

        expect(atCap).toBeGreaterThanOrEqual(300);
        expect(reports.length - atCap).toBeLessThanOrEqual(4);
        expect(reports.at(-1)?.progress).toBeGreaterThan(320);
        expect(write.mock.calls.at(-1)?.[0]).toStrictEqual({ ...tool, ended: true });
    });

    it("keeps names within the column cap", async () => {
        const write = vi.fn(async (_chunk: ToolProgressChunk) => {});
        const call = createToolProgressWriter(write, fakeClock())({ ...tool, serverName: "s".repeat(900) });

        call.push({ progress: 1 });
        await call.finish();

        expect(write.mock.calls[0]?.[0].serverName).toHaveLength(500);
    });
});

/** A server over a fake transport: one tool that reports progress while it runs. */
const fakeServer = (script: (token: unknown, notify: (params: Record<string, unknown>) => void) => void) => {
    const requests: { method?: string; params?: Record<string, any> }[] = [];
    const transport: MCPTransport = {
        close: async () => {},
        send: async (message) => {
            const request = message as { id?: number; method?: string; params?: Record<string, any> };

            requests.push(request);

            const reply = (result: unknown) => {
                queueMicrotask(() => transport.onmessage?.({ id: request.id, jsonrpc: "2.0", result } as never));
            };

            switch (request.method) {
                case "initialize": {
                    reply({ capabilities: { tools: {} }, protocolVersion: "2025-06-18", serverInfo: { name: "fake", version: "1" } });
                    break;
                }
                case "tools/call": {
                    const token = request.params?._meta?.progressToken;

                    queueMicrotask(() => {
                        script(token, (params) => transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/progress", params } as never));
                        reply({ content: [{ text: "done", type: "text" }] });
                    });
                    break;
                }
                case "tools/list": {
                    reply({ tools: [{ description: "Index it", inputSchema: { properties: {}, type: "object" }, name: "index" }] });
                    break;
                }
                default: {
                    break;
                }
            }
        },
        start: async () => {},
    };

    return { requests, transport };
};

describe(attachProgressTokens, () => {
    const call = async (script: Parameters<typeof fakeServer>[0], progressCall?: { onProgress: (progress: McpProgress) => void; token: string }) => {
        const server = fakeServer(script);
        const errors: unknown[] = [];
        const client = await createMCPClient({
            onUncaughtError: (error) => {
                errors.push(error);
            },
            transport: server.transport,
        });

        attachProgressTokens(client);

        const tools = await client.tools();
        const run = async () => await (tools["index"] as any).execute({}, { messages: [], toolCallId: "call_1" });
        const result = await (progressCall ? runWithProgressCall(progressCall, run) : run());

        return { errors, requests: server.requests, result };
    };

    it("sends the call's id as the progress token and relays its notifications", async () => {
        const seen: McpProgress[] = [];
        const { errors, requests, result } = await call(
            (token, notify) => {
                notify({ message: "Reading", progress: 1, progressToken: token, total: 3 });
                notify({ progress: 2, progressToken: token });
                notify({ progress: 9, progressToken: "someone-else" });
            },
            {
                onProgress: (progress) => {
                    seen.push(progress);
                },
                token: "call_1",
            },
        );

        expect(requests.find((request) => request.method === "tools/call")?.params?._meta?.progressToken).toBe("call_1");
        expect(seen).toStrictEqual([{ message: "Reading", progress: 1, total: 3 }, { progress: 2 }]);
        // The notifications are consumed here, not reported by the client as unsupported messages.
        expect(errors).toStrictEqual([]);
        expect(result).toBeDefined();
    });

    it("sends no token outside a tool call that reports progress", async () => {
        const { requests } = await call(() => {});

        expect(requests.find((request) => request.method === "tools/call")?.params?._meta).toBeUndefined();
    });

    it("stops relaying once the call has its response", async () => {
        const seen: McpProgress[] = [];
        const server = fakeServer((token, notify) => notify({ progress: 1, progressToken: token }));
        const client = await createMCPClient({ transport: server.transport });

        attachProgressTokens(client);

        const tools = await client.tools();

        await runWithProgressCall(
            {
                onProgress: (progress) => {
                    seen.push(progress);
                },
                token: "call_1",
            },
            async () => await (tools["index"] as any).execute({}, { messages: [], toolCallId: "call_1" }),
        );
        server.transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 5, progressToken: "call_1" } } as never);

        expect(seen).toStrictEqual([{ progress: 1 }]);
    });

    it("forgets a call whose request was refused", async () => {
        const seen: McpProgress[] = [];
        const server = fakeServer(() => {});
        const send = server.transport.send.bind(server.transport);

        // The wire refuses a tool call; the hook sits above it.
        server.transport.send = async (message, options) => {
            if ((message as { method?: string }).method === "tools/call") {
                throw new Error("offline");
            }

            await send(message, options);
        };

        const client = await createMCPClient({ transport: server.transport });

        attachProgressTokens(client);

        const tools = await client.tools();
        const progressCall = createProgressCall({
            onProgress: (progress) => {
                seen.push(progress);
            },
            token: "call_1",
        });

        await expect(
            runWithProgressCall(progressCall, async () => await (tools["index"] as any).execute({}, { messages: [], toolCallId: "call_1" })),
        ).rejects.toThrow("offline");

        server.transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 5, progressToken: "call_1" } } as never);

        expect(seen).toStrictEqual([]);
    });

    it("forgets a call when its owner releases it, even though no response came", async () => {
        const seen: McpProgress[] = [];
        const server = fakeServer(() => {});
        const send = server.transport.send.bind(server.transport);

        // The server never answers a tool call.
        server.transport.send = async (message, options) => {
            if ((message as { method?: string }).method !== "tools/call") {
                await send(message, options);
            }
        };

        const client = await createMCPClient({ transport: server.transport });

        attachProgressTokens(client);

        const tools = await client.tools();

        const progressCall = createProgressCall({
            onProgress: (progress) => {
                seen.push(progress);
            },
            token: "call_1",
        });

        void runWithProgressCall(progressCall, async () => await (tools["index"] as any).execute({}, { messages: [], toolCallId: "call_1" })).catch(() => {});
        await new Promise((resolve) => {
            setTimeout(resolve, 10);
        });

        server.transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1, progressToken: "call_1" } } as never);
        progressCall.release();
        server.transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 2, progressToken: "call_1" } } as never);

        expect(seen).toStrictEqual([{ progress: 1 }]);
    });

    it("leaves a client without a transport alone", () => {
        expect(() => attachProgressTokens({} as never)).not.toThrow();
    });
});
