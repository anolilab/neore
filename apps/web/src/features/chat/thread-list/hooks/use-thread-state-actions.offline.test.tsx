// @vitest-environment jsdom

/**
 * The snooze actions against the real query client, with the connection toggled. The write rule of the web client is faked in
 * two cases it decides: a write made while the connection is down is refused at once when it is `onlineOnly`, and queued for the
 * reconnect otherwise.
 */
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { server, write } = vi.hoisted(() => {
    const fake = { online: true, queued: [] as (() => void)[], written: [] as unknown[] };

    const send = (args: unknown, call?: { onlineOnly?: boolean }): Promise<unknown> => {
        if (fake.online) {
            fake.written.push(args);

            return Promise.resolve(null);
        }

        if (call?.onlineOnly) {
            return Promise.reject(new Error("Offline: this change needs the connection."));
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
        showError: () => {},
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

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

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
        server.queued.length = 0;
        server.written.length = 0;
        onlineManager.setOnline(true);
    });

    afterEach(() => {
        onlineManager.setOnline(true);
        client.clear();
        vi.restoreAllMocks();
    });

    it("refuses a custom time at once, and no snooze is written once the connection returns", async () => {
        goOffline();
        const { result } = renderHook(() => useThreadStateActions(), { wrapper });

        // The dialog's Cancel does not reach the hook: the dialog keeps the choice and closes, so nothing is saved after this.
        await expect(result.current.snoozeAt("t1", UNTIL, undefined)).resolves.toBe(false);
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
        await expect(result.current.snoozeAt("t1", UNTIL, undefined)).resolves.toBe(true);
        onlineManager.setOnline(true);

        await waitFor(() => {
            expect(server.written).toHaveLength(2);
        });
        expect(server.written.map((args) => (args as { chosenAt: number }).chosenAt)).toEqual([choseLater, choseEarlier]);
    });
});
