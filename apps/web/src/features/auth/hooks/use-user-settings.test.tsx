/**
 * `updateLatest` queues settings writes: they leave one at a time and each carries the newest cached
 * value of its fields, so a save that was started first can never be the one that lands last.
 */

import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useUpdateUserSettings } from "./use-user-settings";

const QUERY_KEY = ["getUserSettings"];

const harness = vi.hoisted(() => {
    return {
        sent: [] as { fail: () => void; release: () => void; value: string | undefined }[],
        serverRow: undefined as { threadTitleInstructions: string; userId: string } | undefined,
    };
});

const sendSave = (body: { threadTitleInstructions?: string }) =>
    new Promise<void>((resolve, reject) => {
        harness.sent.push({ fail: () => reject(new Error("save failed")), release: resolve, value: body.threadTitleInstructions });
    });

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                auth: {
                    functions: {
                        getUserSettings: {
                            queryOptions: () => {
                                return { queryFn: async () => harness.serverRow ?? null, queryKey: ["getUserSettings"] };
                            },
                        },
                        updateUserSettings: {
                            mutationOptions: () => {
                                return {
                                    mutationFn: sendSave,
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
    harness.serverRow = undefined;

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

    it("drops a queued write when the account changed while it waited", async () => {
        const { queryClient, result } = setup();

        queryClient.setQueryData(QUERY_KEY, { threadTitleInstructions: "", userId: "guest" });

        let second: Promise<void> = Promise.resolve();

        act(() => {
            void result.current.updateLatest(() => {
                return { threadTitleInstructions: "First" };
            });
            second = result.current.updateLatest(() => {
                return { threadTitleInstructions: "Second" };
            });
        });
        await flush();

        // Signing in over the guest replaces the cache with the new account's row.
        queryClient.setQueryData(QUERY_KEY, { threadTitleInstructions: "", userId: "member" });

        const outcome = expect(second).rejects.toThrow("account changed");

        await act(async () => {
            harness.sent[0]?.release();
            await Promise.resolve();
        });
        await outcome;

        // Only the first request, made before the switch, ever left.
        expect(harness.sent).toHaveLength(1);
    });

    it("drops a queued write when the cache was cleared and the new account has no settings row yet", async () => {
        const { queryClient, result } = setup();

        queryClient.setQueryData(QUERY_KEY, null);

        let second: Promise<void> = Promise.resolve();

        act(() => {
            void result.current.updateLatest(() => {
                return { threadTitleInstructions: "First" };
            });
            second = result.current.updateLatest(() => {
                return { threadTitleInstructions: "Second" };
            });
        });
        await flush();

        queryClient.clear();
        queryClient.setQueryData(QUERY_KEY, null);

        const outcome = expect(second).rejects.toThrow("account changed");

        await act(async () => {
            harness.sent[0]?.release();
            await Promise.resolve();
        });
        await outcome;

        expect(harness.sent).toHaveLength(1);
    });

    it("still sends a queued write when the cache was rebuilt for the same account", async () => {
        const { queryClient, result } = setup();

        queryClient.setQueryData(QUERY_KEY, { threadTitleInstructions: "", userId: "member" });

        act(() => {
            void result.current.updateLatest(() => {
                return { threadTitleInstructions: "First" };
            });
            void result.current.updateLatest(() => {
                return { threadTitleInstructions: "Second" };
            });
        });
        await flush();

        // Switching between sessions of one account clears the cache; the same row comes back from the server.
        queryClient.clear();
        queryClient.setQueryData(QUERY_KEY, { threadTitleInstructions: "First", userId: "member" });

        await act(async () => {
            harness.sent[0]?.release();
            await Promise.resolve();
        });
        await flush();

        expect(harness.sent).toHaveLength(2);
    });

    it("sends the queued edit, not the server's old value, when the same account's cache was rebuilt", async () => {
        const { queryClient, result } = setup();

        queryClient.setQueryData(QUERY_KEY, { threadTitleInstructions: "", userId: "member" });

        act(() => {
            void result.current.updateLatest(() => {
                return { threadTitleInstructions: "First" };
            });
            void result.current.updateLatest(() => {
                return { threadTitleInstructions: "Edited" };
            });
        });
        await flush();

        // The rebuilt row is the server's, from before the queued edit: it must not be sent back in place of the edit.
        queryClient.clear();
        queryClient.setQueryData(QUERY_KEY, { threadTitleInstructions: "Server", userId: "member" });

        await act(async () => {
            harness.sent[0]?.release();
            await Promise.resolve();
        });
        await flush();

        // Each write sends the newest cached value when its turn comes, so both carry "Edited".
        expect(harness.sent.map((request) => request.value)).toEqual(["Edited", "Edited"]);
    });

    it("sends a queued edit when the rebuilt cache has no row and the server's row is the same account's", async () => {
        const { queryClient, result } = setup();

        queryClient.setQueryData(QUERY_KEY, { threadTitleInstructions: "", userId: "member" });

        act(() => {
            void result.current.updateLatest(() => {
                return { threadTitleInstructions: "First" };
            });
            void result.current.updateLatest(() => {
                return { threadTitleInstructions: "Edited" };
            });
        });
        await flush();

        // Same-account session switch: the cache is rebuilt and its row has not loaded yet when the queued edit runs.
        queryClient.clear();
        harness.serverRow = { threadTitleInstructions: "Server", userId: "member" };

        await act(async () => {
            harness.sent[0]?.release();
            await Promise.resolve();
        });
        await flush();

        expect(harness.sent.map((request) => request.value)).toEqual(["Edited", "Edited"]);
    });

    it("refuses a queued edit when the server's row belongs to another account", async () => {
        const { queryClient, result } = setup();

        queryClient.setQueryData(QUERY_KEY, { threadTitleInstructions: "", userId: "member" });

        act(() => {
            void result.current.updateLatest(() => {
                return { threadTitleInstructions: "First" };
            });
            void result.current.updateLatest(() => {
                return { threadTitleInstructions: "Edited" };
            });
        });
        await flush();

        queryClient.clear();
        harness.serverRow = { threadTitleInstructions: "Other", userId: "someone-else" };

        await act(async () => {
            harness.sent[0]?.release();
            await Promise.resolve();
        });
        await flush();

        expect(harness.sent).toHaveLength(1);
    });

    it("puts back the value the person had before a failed save, not the unsaved one", async () => {
        const { queryClient, result } = setup();

        queryClient.setQueryData(QUERY_KEY, { threadTitleInstructions: "Before" });

        let outcome: Promise<void> = Promise.resolve();

        act(() => {
            outcome = result.current.updateLatest(() => {
                return { threadTitleInstructions: "Unsaved" };
            });
        });
        await flush();
        expect(queryClient.getQueryData(QUERY_KEY)).toEqual({ threadTitleInstructions: "Unsaved" });

        const rejected = expect(outcome).rejects.toThrow("save failed");

        await act(async () => {
            harness.sent[0]?.fail();
            await Promise.resolve();
        });
        await rejected;
        await flush();

        expect(queryClient.getQueryData(QUERY_KEY)).toEqual({ threadTitleInstructions: "Before" });
    });

    it("leaves the new account's cache alone when a save of the previous account fails", async () => {
        const { queryClient, result } = setup();

        queryClient.setQueryData(QUERY_KEY, { threadTitleInstructions: "Old", userId: "guest" });

        let outcome: Promise<void> = Promise.resolve();

        act(() => {
            outcome = result.current.updateLatest(() => {
                return { threadTitleInstructions: "New" };
            });
        });
        await flush();

        // Signing in over the guest rebuilds the cache with the new account's row while the save is out.
        await vi.waitFor(() => expect(harness.sent).toHaveLength(1));
        queryClient.clear();
        queryClient.setQueryData(QUERY_KEY, { threadTitleInstructions: "Member's", userId: "member" });

        const rejected = expect(outcome).rejects.toThrow("save failed");

        await act(async () => {
            harness.sent[0]?.fail();
            await Promise.resolve();
        });
        await rejected;

        expect(queryClient.getQueryData(QUERY_KEY)).toEqual({ threadTitleInstructions: "Member's", userId: "member" });
    });
});

describe("useUpdateUserSettings.updateLatest with failFast", () => {
    afterEach(async () => {
        onlineManager.setOnline(true);

        for (const request of harness.sent) {
            request.release();
        }

        await flush();
    });

    it("fails at once while offline, sending nothing and keeping the value it had", async () => {
        const { queryClient, result } = setup();

        onlineManager.setOnline(false);

        let outcome: Promise<void> | undefined;

        act(() => {
            outcome = result.current.updateLatest(
                () => {
                    return { threadTitleInstructions: "Short titles" };
                },
                { failFast: true },
            );
        });

        await expect(outcome).rejects.toThrow("no connection");
        expect(harness.sent).toHaveLength(0);
        expect(queryClient.getQueryData(QUERY_KEY)).toEqual({ threadTitleInstructions: "" });
    });

    it("fails when the connection drops while it waits behind an earlier save, instead of waiting for the connection", async () => {
        const { queryClient, result } = setup();

        let outcome: Promise<void> | undefined;

        act(() => {
            void result.current.updateLatest(() => {
                return { threadTitleInstructions: "First" };
            });
            outcome = result.current.updateLatest(
                () => {
                    return { threadTitleInstructions: "Second" };
                },
                { failFast: true },
            );
        });
        await flush();

        // The earlier save is out and pauses; the connection drops.
        act(() => {
            onlineManager.setOnline(false);
        });

        await expect(outcome).rejects.toThrow("no connection");
        // Only the earlier save was sent, and the cache shows its value again, not the unsaved one.
        expect(harness.sent).toHaveLength(1);
        expect(queryClient.getQueryData(QUERY_KEY)).toEqual({ threadTitleInstructions: "First" });
    });

    it("leaves a later edit of the same field alone when it is refused, even when that edit set the same value", async () => {
        const { queryClient, result } = setup();

        let outcome: Promise<void> | undefined;

        act(() => {
            void result.current.updateLatest(() => {
                return { threadTitleInstructions: "First" };
            });
            outcome = result.current.updateLatest(
                () => {
                    return { threadTitleInstructions: "Second" };
                },
                { failFast: true },
            );
            // A later edit sets the same value again.
            void result.current.updateLatest(() => {
                return { threadTitleInstructions: "Second" };
            });
        });
        await flush();

        act(() => {
            onlineManager.setOnline(false);
        });

        await expect(outcome).rejects.toThrow("no connection");
        expect(queryClient.getQueryData(QUERY_KEY)).toEqual({ threadTitleInstructions: "Second" });

        // Let the queue drain, so the next test starts with no write in flight.
        act(() => {
            onlineManager.setOnline(true);
        });
        await act(async () => {
            harness.sent[0]?.release();
            await Promise.resolve();
        });
        await flush();

        for (const request of harness.sent) {
            request.release();
        }

        await flush();
    });

    it("waits its turn behind a save already in flight, so two writes never run at once", async () => {
        const { result } = setup();

        act(() => {
            void result.current.updateLatest(() => {
                return { threadTitleInstructions: "First" };
            });
            void result.current.updateLatest(
                () => {
                    return { threadTitleInstructions: "Second" };
                },
                { failFast: true },
            );
        });
        await flush();

        // One request is out. A queued save sends the newest cached value when its turn comes, so the first one carries "Second".
        expect(harness.sent).toHaveLength(1);

        await act(async () => {
            harness.sent[0]?.release();
            await Promise.resolve();
        });
        await flush();

        expect(harness.sent.map((request) => request.value)).toEqual(["Second", "Second"]);
    });
});
