/**
 * A computer too old for the backend cannot start a coding agent: the Start button is off and points at the reason.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

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
    return {
        bridge: {
            connect: vi.fn(async (_id: string): Promise<void> => {}),
            disconnect: vi.fn(async (_id: string): Promise<boolean> => true),
        },
    };
});

vi.mock("@/lib/native/bridge", () => {
    return {
        connectNativeHost: bridge.connect,
        disconnectNativeHost: bridge.disconnect,
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

type Reconnect = { attempt: number | null; maxAttempts: number; phase: "connecting" | "gaveUp" | "waiting"; reason: string | null };

const rowClient = new QueryClient();
const rowElement = (reconnect: Reconnect | undefined, connected: boolean | undefined) => (
    <QueryClientProvider client={rowClient}>
        <ul>
            <DeviceRow
                connected={connected}
                device={sshServer as never}
                isThisComputer={false}
                now={Date.now()}
                onConnectionChange={() => {}}
                reconnect={reconnect}
            />
        </ul>
    </QueryClientProvider>
);
/** A person's click, through Testing Library's own event sequence. */
const press = async (element: HTMLElement): Promise<void> => {
    await userEvent.click(element);
};
const renderRow = (reconnect?: Reconnect) => render(rowElement(reconnect, false));

describe("<DeviceRow> connection failure", () => {
    it("shows the device core's reason while it retries, in the row's words, and not once the server is connected", async () => {
        const view = renderRow({ attempt: 1, maxAttempts: 5, phase: "waiting", reason: "the connection was lost" });

        expect(screen.getByRole("status").textContent).toBe("The connection was lost.");

        view.rerender(rowElement({ attempt: null, maxAttempts: 5, phase: "gaveUp", reason: "Connection timed out (gave up after 5 attempts)" }, false));
        expect(screen.getByRole("status").textContent).toBe("Connection timed out (gave up after 5 attempts)");

        view.rerender(rowElement(undefined, true));
        expect(screen.getByRole("status").textContent).toBe("");
    });

    it("shows why a Retry was refused until the device core reports a newer reason", async () => {
        const gaveUp = { attempt: null, maxAttempts: 5, phase: "gaveUp" as const, reason: "Connection timed out" };

        bridge.connect.mockRejectedValueOnce(new Error("too many attempts to reach this server"));

        const view = renderRow(gaveUp);

        await press(screen.getByRole("button", { name: "Retry" }));
        await waitFor(() => expect(screen.getByRole("status").textContent).toBe("too many attempts to reach this server"));

        view.rerender(rowElement({ ...gaveUp, reason: "No route to host" }, false));
        expect(screen.getByRole("status").textContent).toBe("No route to host");
    });

    it("shows why the person's Connect failed when the server is not kept, until it connects", async () => {
        bridge.connect.mockRejectedValueOnce(new Error("Permission denied (publickey)."));

        const view = renderRow();

        await press(screen.getByRole("button", { name: "Connect" }));
        await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Permission denied (publickey)."));
        expect(screen.getByRole("button", { name: "Connect" }).getAttribute("aria-describedby")).toBe("device-error-s1");

        // A long failure is cut in the middle, keeping its end.
        bridge.connect.mockRejectedValueOnce(new Error(`${"x".repeat(400)} connect again`));
        await press(screen.getByRole("button", { name: "Connect" }));
        await waitFor(() => expect(screen.getByRole("status").textContent?.endsWith("connect again")).toBe(true));
        expect([...(screen.getByRole("status").textContent ?? "")]).toHaveLength(300);

        // Connected from elsewhere, then let go: the earlier failure explains nothing any more.
        view.rerender(rowElement(undefined, true));
        view.rerender(rowElement(undefined, false));
        expect(screen.getByRole("status").textContent).toBe("");
    });
});
