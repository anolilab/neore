/**
 * `updateLatest` queues settings writes: they leave one at a time and each carries the newest cached
 * value of its fields, so a save that was started first can never be the one that lands last.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useUpdateUserSettings } from "./use-user-settings";

const QUERY_KEY = ["getUserSettings"];

const harness = vi.hoisted(() => {
    return { sent: [] as { release: () => void; value: string | undefined }[] };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                auth: {
                    functions: {
                        getUserSettings: {
                            queryOptions: () => {
                                return { queryKey: ["getUserSettings"] };
                            },
                        },
                        updateUserSettings: {
                            mutationOptions: () => {
                                return {
                                    mutationFn: (body: { threadTitleInstructions?: string }) =>
                                        new Promise<void>((resolve) => {
                                            harness.sent.push({ release: resolve, value: body.threadTitleInstructions });
                                        }),
                                };
                            },
                        },
                    },
                },
            };
        },
    };
});

const setup = () => {
    const queryClient = new QueryClient();

    queryClient.setQueryData(QUERY_KEY, { threadTitleInstructions: "" });
    harness.sent = [];

    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;

    return { queryClient, ...renderHook(() => useUpdateUserSettings(), { wrapper }) };
};

const flush = async () => {
    await act(async () => {
        await Promise.resolve();
    });
};

describe("useUpdateUserSettings.updateLatest", () => {
    // The write queue is module state: a request left open would hold up the next test.
    afterEach(async () => {
        for (const request of harness.sent) {
            request.release();
        }

        await flush();
    });

    it("sends the second save only after the first one settles, and ends on the newest value", async () => {
        const { queryClient, result } = setup();

        act(() => {
            void result.current.updateLatest(() => {
                return { threadTitleInstructions: "Short titles" };
            });
            void result.current.updateLatest(() => {
                return { threadTitleInstructions: "Short titles, no emoji" };
            });
        });
        await flush();

        // Only one request is out; the second waits its turn and cannot overtake it.
        expect(harness.sent).toHaveLength(1);

        await act(async () => {
            harness.sent[0]?.release();
            await Promise.resolve();
        });
        await flush();

        expect(harness.sent.map((request) => request.value)).toEqual(["Short titles, no emoji", "Short titles, no emoji"]);
        expect(queryClient.getQueryData(QUERY_KEY)).toEqual({ threadTitleInstructions: "Short titles, no emoji" });
    });

    it("still sends a reversal queued behind a save of a different value", async () => {
        const { result } = setup();

        act(() => {
            void result.current.updateLatest(() => {
                return { threadTitleInstructions: "Short titles" };
            });
            void result.current.updateLatest(() => {
                return { threadTitleInstructions: "" };
            });
        });
        await flush();
        await act(async () => {
            harness.sent[0]?.release();
            await Promise.resolve();
        });
        await flush();

        expect(harness.sent.at(-1)?.value).toBe("");
    });
});
