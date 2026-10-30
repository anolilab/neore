// @vitest-environment jsdom

import type { CapabilityReport } from "@neore/ai/capabilities";
import { CLOUD_INTERACTIVE_CAPABILITIES, followUpControl, LOCAL_BROWSER_CAPABILITIES } from "@neore/ai/capabilities";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import useRunnerCapabilities from "./use-runner-capabilities";

const chat = vi.hoisted(() => {
    return {
        data: undefined as CapabilityReport | null | undefined,
        isLocalModel: false,
        isLocalStreaming: false,
        isStreaming: false,
        queryArgs: undefined as unknown,
        runner: undefined as "host" | undefined,
        threadLoaded: true,
    };
});

vi.mock("@tanstack/react-query", () => {
    return {
        skipToken: Symbol.for("skipToken"),
        useQuery: () => {
            return { data: chat.data };
        },
    };
});
vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                acp: {
                    functions: {
                        getThreadCapabilities: {
                            queryOptions: (args: unknown) => {
                                chat.queryArgs = args;

                                return {};
                            },
                        },
                    },
                },
            };
        },
    };
});
vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatIsStreaming: () => {
            return { isLocalModel: chat.isLocalModel, isLocalStreaming: chat.isLocalStreaming, isStreaming: chat.isStreaming };
        },
        useChatThread: () => {
            return { thread: chat.threadLoaded ? { runner: chat.runner } : undefined, threadId: "thread-1" };
        },
    };
});

describe("useRunnerCapabilities", () => {
    beforeEach(() => {
        chat.data = undefined;
        chat.isLocalModel = false;
        chat.isLocalStreaming = false;
        chat.isStreaming = false;
        chat.queryArgs = undefined;
        chat.runner = undefined;
        chat.threadLoaded = true;
    });

    it("declares a cloud thread's capabilities in code, with no query", () => {
        const { result } = renderHook(() => useRunnerCapabilities());

        expect(result.current).toBe(CLOUD_INTERACTIVE_CAPABILITIES);
        expect(chat.queryArgs).toBe(Symbol.for("skipToken"));
    });

    it("declares a local-model thread as one that queues and cannot be steered", () => {
        chat.isLocalModel = true;

        const { result } = renderHook(() => useRunnerCapabilities());

        expect(result.current).toBe(LOCAL_BROWSER_CAPABILITIES);
        expect(followUpControl(result.current)).toBe("queue");
        expect(result.current?.groups.tools).toBeUndefined();
    });

    it("keeps a streaming cloud turn's controls when the picker moves to a local model", () => {
        chat.isLocalModel = true;
        chat.isStreaming = true;

        const { result } = renderHook(() => useRunnerCapabilities());

        expect(result.current).toBe(CLOUD_INTERACTIVE_CAPABILITIES);
    });

    it("keeps a streaming local turn's controls when the picker moves to a cloud model", () => {
        chat.isLocalStreaming = true;
        chat.isStreaming = true;

        const { result } = renderHook(() => useRunnerCapabilities());

        expect(result.current).toBe(LOCAL_BROWSER_CAPABILITIES);
    });

    it("reads a host thread's report from the backend, and none until it arrives", () => {
        chat.runner = "host";

        const { rerender, result } = renderHook(() => useRunnerCapabilities());

        expect(chat.queryArgs).toEqual({ threadId: "thread-1" });
        expect(result.current).toBeNull();
        expect(followUpControl(result.current)).toBe("none");

        chat.data = { groups: { turns: { followUp: { degradation: "restart", kind: "steer" } } }, reportedAt: 5, version: 1 };
        rerender();

        expect(followUpControl(result.current)).toBe("steer-restart");
    });

    it("reports nothing while the thread has not loaded, whichever runner it turns out to have", () => {
        chat.threadLoaded = false;

        const { result } = renderHook(() => useRunnerCapabilities());

        expect(result.current).toBeNull();
        expect(followUpControl(result.current)).toBe("none");
    });

    it("does not offer a host's native steer, which the backend refuses", () => {
        chat.runner = "host";
        chat.data = { groups: { turns: { cancel: { degradation: "none", supported: true }, followUp: { kind: "steer" } } }, reportedAt: 5, version: 1 };

        const { result } = renderHook(() => useRunnerCapabilities());

        expect(followUpControl(result.current)).toBe("none");
        expect(result.current?.groups.turns?.cancel).toEqual({ degradation: "none", supported: true });
    });
});
