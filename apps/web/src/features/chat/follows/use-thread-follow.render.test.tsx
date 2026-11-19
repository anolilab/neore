import { QueryClient, QueryClientProvider, skipToken } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useThreadFollow } from "./use-thread-follow";

type State = "on" | "off" | "muted";

const server = vi.hoisted(() => {
    return {
        fetches: 0,
        // Each write waits on its own gate when set, so a test can hold one in flight.
        gates: [] as Promise<void>[],
        queryOptionsCalls: [] as unknown[][],
        started: [] as State[],
        state: "off" as State,
    };
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
                                            server.started.push(state);
                                            await server.gates[server.started.length - 1];
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
        server.gates = [];
        server.queryOptionsCalls = [];
        server.started = [];
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

    it("sends a second change only after the first one finished, so they reach the server in order", async () => {
        let releaseFirst: () => void = () => {};

        server.gates = [
            // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- the web lib target has no Promise.withResolvers
            new Promise<void>((resolve) => {
                releaseFirst = resolve;
            }),
        ];

        const { result } = renderHook(() => useThreadFollow("t1"), { wrapper });

        await waitFor(() => expect(result.current.state).toBe("off"));

        act(() => {
            result.current.setState("on");
            result.current.setState("muted");
        });

        await waitFor(() => expect(server.started).toStrictEqual(["on"]));

        act(() => {
            releaseFirst();
        });

        await waitFor(() => expect(server.started).toStrictEqual(["on", "muted"]));
        await waitFor(() => expect(server.state).toBe("muted"));
    });
});
