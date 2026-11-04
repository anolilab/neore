/**
 * A computer too old for the backend cannot start a coding agent: the Start button is off and points at the reason.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { clearDeviceErrors } from "../lib/device-errors";
import { DeviceRow, StartAgents } from "./devices-settings";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                i18n: { _: (descriptor: { id: string }) => descriptor.id, locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("sonner", () => {
    return { toast: { error: vi.fn(), success: vi.fn() } };
});

vi.mock("./device-scope", () => {
    return { default: () => null };
});

const { bridge } = vi.hoisted(() => {
    return { bridge: { connect: vi.fn(async (_id: string): Promise<void> => {}) } };
});

vi.mock("@/lib/native/bridge", () => {
    return {
        connectNativeHost: bridge.connect,
        disconnectNativeHost: vi.fn(async () => {}),
        probeNativeHost: vi.fn(),
    };
});

vi.mock("@tanstack/react-router", () => {
    return { useNavigate: () => vi.fn() };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                devices: {
                    functions: {
                        renameDevice: {
                            mutationOptions: () => {
                                return { mutationFn: vi.fn(async () => null) };
                            },
                        },
                        revokeDevice: {
                            mutationOptions: () => {
                                return { mutationFn: vi.fn(async () => null) };
                            },
                        },
                    },
                },
                acp: {
                    remote: {
                        startHostSession: {
                            mutationOptions: () => {
                                return { mutationFn: vi.fn(async () => null) };
                            },
                        },
                    },
                },
            };
        },
    };
});

const device = {
    _id: "d1",
    acpOffers: [{ agentKey: "claude", agentLabel: "Claude", folderId: "f1", folderLabel: "app" }],
    name: "Laptop",
    platform: "macos",
    toolNames: [],
};

const renderStart = (updateRequired: boolean) =>
    render(
        <QueryClientProvider client={new QueryClient()}>
            <StartAgents device={{ ...device, updateRequired } as never} online />
        </QueryClientProvider>,
    );

describe("<StartAgents>", () => {
    it("disables Start for a computer that needs an update and names the reason", () => {
        renderStart(true);

        const button = screen.getByRole("button", { name: "Start Claude in app" }) as HTMLButtonElement;

        expect(button.disabled).toBe(true);
        expect(button.getAttribute("aria-describedby")).toBe("device-update-d1");
    });

    it("leaves Start on for an up-to-date computer", () => {
        renderStart(false);

        const button = screen.getByRole("button", { name: "Start Claude in app" }) as HTMLButtonElement;

        expect(button.disabled).toBe(false);
        expect(button.getAttribute("aria-describedby")).toBeNull();
    });
});

const sshServer = { _id: "s1", acpOffers: [], name: "build box", platform: "linux", projectIds: [], toolNames: [], transport: "ssh" };

const renderRow = (reconnect?: { attempt: number | null; maxAttempts: number; phase: "connecting" | "gaveUp" | "waiting"; reason: string | null }) =>
    render(
        <QueryClientProvider client={new QueryClient()}>
            <ul>
                <DeviceRow
                    connected={false}
                    device={sshServer as never}
                    isThisComputer={false}
                    now={Date.now()}
                    onConnectionChange={() => {}}
                    reconnect={reconnect}
                />
            </ul>
        </QueryClientProvider>,
    );

describe("<DeviceRow> connection errors", () => {
    it("keeps the error of a first failed connect on the row, with no reconnect state", async () => {
        clearDeviceErrors("s1");
        bridge.connect.mockRejectedValueOnce(new Error("Permission denied (publickey)."));
        renderRow();
        fireEvent.click(screen.getByRole("button", { name: "Connect" }));

        expect(await screen.findByText("Permission denied (publickey).")).toBeTruthy();
    });

    it("keeps the reason a server gave up with while it retries", async () => {
        clearDeviceErrors("s1");

        const view = renderRow({ attempt: null, maxAttempts: 5, phase: "gaveUp", reason: "Connection timed out" });

        expect(await screen.findByText("Connection timed out")).toBeTruthy();
        view.rerender(
            <QueryClientProvider client={new QueryClient()}>
                <ul>
                    <DeviceRow
                        connected={false}
                        device={sshServer as never}
                        isThisComputer={false}
                        now={Date.now()}
                        onConnectionChange={() => {}}
                        reconnect={{ attempt: 1, maxAttempts: 5, phase: "connecting", reason: null }}
                    />
                </ul>
            </QueryClientProvider>,
        );

        expect(screen.getByText("Connection timed out")).toBeTruthy();
    });
});
