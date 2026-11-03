/**
 * The relay tells the person when a wrong clock makes the backend refuse a signed message, for the shell's progress
 * reports as for its manifests.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { clearDeviceErrors, useDeviceErrors } from "../lib/device-errors";
import DeviceRelay from "./device-relay";

const { bridge, mutations, toastError } = vi.hoisted(() => {
    const clockSkew = Object.assign(new Error("Server English"), { data: { code: "DEVICE_CLOCK_SKEW", direction: "behind", minutes: 10 } });

    return {
        bridge: {
            changedListener: undefined as undefined | (() => void),
            progressListener: undefined as undefined | ((report: Record<string, unknown>) => void),
        },
        mutations: {
            heartbeat: vi.fn(async () => {
                return { paired: true };
            }),
            reportProgress: vi.fn(async (): Promise<never> => {
                throw clockSkew;
            }),
            updateManifest: vi.fn(async (): Promise<unknown> => null),
        },
        toastError: vi.fn(),
    };
});

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/core/macro", () => {
    return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
});

vi.mock("sonner", () => {
    return { toast: { error: toastError } };
});

vi.mock("@/lib/native/bridge", () => {
    return {
        disconnectNativeHost: vi.fn(),
        executeOnNativeDevice: vi.fn(),
        getNativeDeviceManifest: vi.fn(async () => {
            return { payload: "{}", signature: "s" };
        }),
        getNativeDeviceStatus: vi.fn(async () => {
            return { deviceId: "d1", hosts: [] };
        }),
        // Like the real bridge, a listener is told once on subscribing.
        onNativeDeviceChanged: (listener: () => void) => {
            bridge.changedListener = listener;
            queueMicrotask(listener);

            return () => {};
        },
        onNativeDeviceProgress: (listener: (report: Record<string, unknown>) => void) => {
            bridge.progressListener = listener;

            return () => {};
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    const options = (mutationFunction: unknown) => {
        return {
            mutationOptions: () => {
                return { mutationFn: mutationFunction };
            },
        };
    };
    const never = options(vi.fn(async () => null));

    return {
        useCRPC: () => {
            return {
                devices: {
                    functions: {
                        claimDeviceCall: never,
                        completeDeviceCall: never,
                        heartbeatDevice: options(mutations.heartbeat),
                        listPendingDeviceCalls: {
                            queryOptions: () => {
                                return { queryFn: async () => [], queryKey: ["pending"] };
                            },
                        },
                        releaseDeviceCall: never,
                        reportDeviceCallProgress: options(mutations.reportProgress),
                        updateDeviceManifest: options(mutations.updateManifest),
                    },
                },
            };
        },
    };
});

describe("<DeviceRelay>", () => {
    it("shows the clock-skew notice when a progress report is refused for the computer's clock", async () => {
        render(
            <QueryClientProvider client={new QueryClient()}>
                <DeviceRelay />
            </QueryClientProvider>,
        );

        await waitFor(() => expect(mutations.heartbeat).toHaveBeenCalled());
        await waitFor(() => expect(bridge.progressListener).toBeDefined());

        bridge.progressListener?.({ callId: "c1", deviceId: "d1", payload: "{}", signature: "s" });

        await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringContaining("about 10 minutes behind"), { id: "device-clock-skew" }));
    });

    it("keeps a stale rejection of an older overlapping send out of the row after a newer send went through", async () => {
        const stale = Object.assign(new Error("Manifest is stale or malformed"), { data: {} });

        mutations.updateManifest.mockReset();
        mutations.updateManifest
            .mockImplementationOnce(
                () =>
                    new Promise((_resolve, reject) => {
                        setTimeout(reject, 50, stale);
                    }),
            )
            .mockImplementation(async () => null);
        clearDeviceErrors("d1");
        render(
            <QueryClientProvider client={new QueryClient()}>
                <DeviceRelay />
            </QueryClientProvider>,
        );
        await waitFor(() => expect(bridge.changedListener).toBeDefined());

        const { result } = renderHook(() => useDeviceErrors("d1"));

        act(() => bridge.changedListener?.());
        await waitFor(() => expect(mutations.updateManifest).toHaveBeenCalledTimes(1));
        act(() => bridge.changedListener?.());
        await waitFor(() => expect(mutations.updateManifest).toHaveBeenCalledTimes(2));
        await act(async () => {
            await new Promise((resolve) => {
                setTimeout(resolve, 100);
            });
        });

        expect(result.current).toEqual([]);
    });

    it("remembers the refusal of the newest send, with the clock offset a clock refusal carries", async () => {
        const clock = Object.assign(new Error("Server English"), { data: { code: "DEVICE_CLOCK_SKEW", direction: "ahead", minutes: 12 } });

        mutations.updateManifest.mockReset();
        mutations.updateManifest.mockRejectedValue(clock);
        clearDeviceErrors("d1");
        render(
            <QueryClientProvider client={new QueryClient()}>
                <DeviceRelay />
            </QueryClientProvider>,
        );
        await waitFor(() => expect(bridge.changedListener).toBeDefined());

        const { result } = renderHook(() => useDeviceErrors("d1"));

        act(() => bridge.changedListener?.());
        await waitFor(() => expect(result.current.at(-1)?.clockOffset).toBe("about 12 minutes ahead"));
    });
});
