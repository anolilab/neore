import { QueryClient, QueryClientProvider, skipToken } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useThreadFollow } from "./use-thread-follow";

type State = "on" | "off" | "muted";

const server = vi.hoisted(() => {
    return { fetches: 0, queryOptionsCalls: [] as unknown[][], state: "off" as State };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                chat: {
                    follows: {
                        functions: {
                            getThreadFollow: {
                                queryKey: (args: { threadId: string }) => ["getThreadFollow", args.threadId],
                                queryOptions: (args: typeof skipToken | { threadId: string }, options?: { live?: boolean }) => {
                                    server.queryOptionsCalls.push([args, options]);

                                    return args === skipToken
                                        ? { queryFn: skipToken, queryKey: ["getThreadFollow", "skipped"] }
                                        : {
                                              queryFn: async () => {
                                                  server.fetches += 1;

                                                  return { state: server.state };
                                              },
                                              queryKey: ["getThreadFollow", args.threadId],
                                          };
                                },
                            },
                            setThreadFollow: {
                                mutationOptions: () => {
                                    return {
                                        mutationFn: async ({ state }: { state: State }) => {
                                            server.state = state;

                                            return null;
                                        },
                                    };
                                },
                            },
                        },
                    },
                },
            };
        },
    };
});

vi.mock("@/lib/toast", () => {
    return { showError: () => {} };
});

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;

describe("useThreadFollow", () => {
    beforeEach(() => {
        server.fetches = 0;
        server.queryOptionsCalls = [];
        server.state = "off";
    });

    it("reads the follow state without a live subscription", async () => {
        const { result } = renderHook(() => useThreadFollow("t1"), { wrapper });

        await waitFor(() => expect(result.current.state).toBe("off"));

        expect(server.queryOptionsCalls).toContainEqual([{ threadId: "t1" }, { live: false }]);
    });

    it("reads the state again after a change, so an open menu shows the new choice", async () => {
        const { result } = renderHook(() => useThreadFollow("t1"), { wrapper });

        await waitFor(() => expect(result.current.state).toBe("off"));

        act(() => {
            result.current.setState("muted");
        });

        await waitFor(() => expect(result.current.state).toBe("muted"));
        expect(server.fetches).toBe(2);
    });
});
