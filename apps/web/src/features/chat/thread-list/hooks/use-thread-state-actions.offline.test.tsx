// @vitest-environment jsdom

/**
 * The snooze actions against the real query client, with the connection toggled. The write rule of the web client is faked in
 * two cases it decides: a write made while the connection is down is refused at once when it is `onlineOnly`, and queued for the
 * reconnect otherwise.
 */
import { MutationCache, onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toasts = vi.hoisted(() => {
    return { errors: [] as string[] };
});

const { server, write } = vi.hoisted(() => {
    const fake = { loseResponse: false, online: true, queued: [] as (() => void)[], refuse: false, written: [] as unknown[] };

    const send = (args: unknown, call?: { onlineOnly?: boolean }): Promise<unknown> => {
        if (fake.online) {
            // The server answers with a refusal, and applies nothing.
            if (fake.refuse) {
                return Promise.reject(Object.assign(new Error("A snooze must end in the future, within a year"), { code: "BAD_REQUEST" }));
            }

            fake.written.push(args);

            // The server committed the write, but the answer never reached the client: a network failure.
            if (fake.loseResponse) {
                return Promise.reject(new TypeError("Failed to fetch"));
            }

            return Promise.resolve(null);
        }

        if (call?.onlineOnly) {
            // The client's own refusal, before anything is sent (`OFFLINE_NOT_QUEUED`).
            return Promise.reject(Object.assign(new Error("'snoozeThread' is online-only and the connection is not live"), { code: "OFFLINE_NOT_QUEUED" }));
        }

        return new Promise((resolve) => {
            fake.queued.push(() => {
                fake.written.push(args);
                resolve(null);
            });
        });
    };

    return { server: fake, write: send };
});

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { t };
        },
    };
});

vi.mock("@/lib/toast", () => {
    return {
        showError: (message: string) => {
            toasts.errors.push(message);
        },
        showSuccess: () => {},
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                chat: {
                    thread_state: {
                        snoozeThread: {
                            mutationOptions: (overrides?: Record<string, unknown>, call?: { onlineOnly?: boolean }) => {
                                return { ...overrides, mutationFn: async (args: unknown) => await write(args, call) };
                            },
                        },
                        unsnoozeThread: {
                            mutationOptions: (overrides?: Record<string, unknown>) => {
                                return { ...overrides, mutationFn: async (args: unknown) => await write(args) };
                            },
                        },
                    },
                },
            };
        },
    };
});

const { useThreadStateActions } = await import("./use-thread-state-actions");

const UNTIL = Date.now() + 3_600_000;

const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });

// A query client whose refetch fails after every mutation succeeds, as a cache hook or a refetch would.
const refetchFails = new QueryClient({
    mutationCache: new MutationCache({
        onSuccess: () => {
            throw new Error("The refetch failed.");
        },
    }),
});

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

const refetchWrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={refetchFails}>{children}</QueryClientProvider>;

const goOffline = (): void => {
    server.online = false;
    onlineManager.setOnline(false);
};

const reconnect = (): void => {
    server.online = true;
    onlineManager.setOnline(true);

    const sends = [...server.queued];

    server.queued.length = 0;

    for (const send of sends) {
        send();
    }
};

const flush = async (): Promise<void> => {
    await act(async () => {
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
    });
};

describe("snoozing while offline", () => {
    beforeEach(() => {
        server.online = true;
        server.loseResponse = false;
        server.refuse = false;
        toasts.errors.length = 0;
        server.queued.length = 0;
        server.written.length = 0;
        onlineManager.setOnline(true);
    });

    afterEach(() => {
        onlineManager.setOnline(true);
        client.clear();
        refetchFails.clear();
        vi.restoreAllMocks();
    });

    it("a custom snooze the server refuses is refused, not unconfirmed, and nothing is written", async () => {
        const { result } = renderHook(() => useThreadStateActions(), { wrapper });

        server.refuse = true;
        await expect(result.current.snoozeAt("t1", UNTIL, undefined)).resolves.toBe("refused");
        expect(server.written).toHaveLength(0);
        // The dialog shows the failure inline; a toast would be a second copy of it.
        expect(toasts.errors).toEqual([]);
    });

    it("a custom snooze whose answer is lost after the server committed it is unconfirmed, not refused", async () => {
        const { result } = renderHook(() => useThreadStateActions(), { wrapper });

        server.loseResponse = true;
        await expect(result.current.snoozeAt("t1", UNTIL, undefined)).resolves.toBe("unconfirmed");

        // The write did reach the server; the dialog must not invite a blind retry as if nothing happened.
        expect(server.written).toHaveLength(1);
    });

    it("a custom snooze that is written, followed by a failing refetch, still reports success", async () => {
        const { result } = renderHook(() => useThreadStateActions(), { wrapper: refetchWrapper });

        await expect(result.current.snoozeAt("t1", UNTIL, undefined)).resolves.toBe("saved");
        expect(server.written).toHaveLength(1);
    });

    it("refuses a custom time at once, and no snooze is written once the connection returns", async () => {
        goOffline();
        const { result } = renderHook(() => useThreadStateActions(), { wrapper });

        // The dialog's Cancel does not reach the hook: the dialog keeps the choice and closes, so nothing is saved after this.
        await expect(result.current.snoozeAt("t1", UNTIL, undefined)).resolves.toBe("refused");
        expect(client.isMutating()).toBe(0);

        reconnect();
        await flush();

        expect(server.written).toEqual([]);
    });

    it("still sends a preset once the connection returns, as before", async () => {
        goOffline();
        const { result } = renderHook(() => useThreadStateActions(), { wrapper });

        act(() => {
            result.current.snooze("t1", "hour", undefined);
        });
        await flush();

        expect(server.written).toEqual([]);

        reconnect();

        await waitFor(() => {
            expect(server.written).toHaveLength(1);
        });
        expect(server.written[0]).toMatchObject({ threadId: "t1" });
    });

    it("a preset queued offline keeps the time it was chosen at, so a custom time chosen later is not replaced when the queue drains", async () => {
        const choseEarlier = 1_000_000;
        const choseLater = 2_000_000;
        const clock = vi.spyOn(Date, "now");

        goOffline();
        clock.mockReturnValue(choseEarlier);
        const { result } = renderHook(() => useThreadStateActions(), { wrapper });

        act(() => {
            result.current.snooze("t1", "hour", undefined);
        });
        await flush();

        // Back online, the custom time is sent first; the preset queued before it drains after.
        server.online = true;
        clock.mockReturnValue(choseLater);
        await expect(result.current.snoozeAt("t1", UNTIL, undefined)).resolves.toBe("saved");
        onlineManager.setOnline(true);

        await waitFor(() => {
            expect(server.written).toHaveLength(2);
        });
        expect(server.written.map((args) => (args as { chosenAt: number }).chosenAt)).toEqual([choseLater, choseEarlier]);
    });
});
