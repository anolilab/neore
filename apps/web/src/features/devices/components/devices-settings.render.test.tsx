/**
 * A computer too old for the backend cannot start a coding agent: the Start button is off and points at the reason.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, onTestFinished, vi } from "vitest";

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

vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray, ...values: unknown[]) => {
            return { id: String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("sonner", () => {
    return { toast: { error: vi.fn(), success: vi.fn() } };
});

vi.mock("./device-scope", () => {
    return { default: () => null };
});

const { startCalls } = vi.hoisted(() => {
    return { startCalls: [] as unknown[] };
});

const { bridge } = vi.hoisted(() => {
    return {
        bridge: {
            connect: vi.fn(async (_id: string): Promise<void> => {}),
            disconnect: vi.fn(async (_id: string): Promise<boolean> => true),
        },
    };
});

vi.mock("@/lib/native/device-bridge", () => {
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
                                return {
                                    mutationFn: vi.fn(async (input: unknown) => {
                                        startCalls.push(input);

                                        return { started: true };
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

describe("<StartAgents> on a computer limited to some projects", () => {
    // `scopeProjects` is what `listDevices` returns: the still-existing projects of `projectIds`, with their titles.
    const renderLimited = (projectIds: string[] | undefined, scopeProjects: { _id: string; title: string }[] | undefined) => {
        startCalls.length = 0;

        return render(
            <QueryClientProvider client={new QueryClient()}>
                <StartAgents device={{ ...device, projectIds, scopeProjects } as never} online />
            </QueryClientProvider>,
        );
    };
    const startButton = () => screen.getByRole("button", { name: "Start Claude in app" }) as HTMLButtonElement;

    it("starts in the one allowed project without asking", async () => {
        renderLimited(["p1"], [{ _id: "p1", title: "Billing" }]);

        expect(screen.queryByRole("combobox")).toBeNull();
        expect(screen.getByText("Starts in Billing, the one project this computer may be used in.")).toBeTruthy();
        expect(startButton().disabled).toBe(false);

        await userEvent.click(startButton());
        await waitFor(() => expect(startCalls).toHaveLength(1));
        expect(startCalls[0]).toMatchObject({ deviceId: "d1", folderId: "f1", projectId: "p1" });
    });

    it("asks which of several allowed projects, and starts only once one is chosen", async () => {
        renderLimited(
            ["p1", "p2"],
            [
                { _id: "p1", title: "Billing" },
                { _id: "p2", title: "Search" },
            ],
        );

        const picker = screen.getByRole("combobox", { name: "Project" });

        expect(
            within(picker)
                .getAllByRole("option")
                .map((option) => option.textContent),
        ).toEqual(["Choose a project", "Billing", "Search"]);
        expect(startButton().disabled).toBe(true);
        expect(startButton().getAttribute("aria-describedby")).toBe(
            screen.getByText("This computer may only be used in some projects. Choose the project to start the agent in.").id,
        );

        await userEvent.selectOptions(picker, "p2");

        expect(startButton().disabled).toBe(false);
        await userEvent.click(startButton());
        await waitFor(() => expect(startCalls).toHaveLength(1));
        expect(startCalls[0]).toMatchObject({ projectId: "p2" });
    });

    it("cannot start, and says why, when none of the allowed projects is available", () => {
        renderLimited([], []);

        expect(screen.queryByRole("combobox")).toBeNull();
        expect(startButton().disabled).toBe(true);
        expect(startButton().getAttribute("aria-describedby")).toBe(
            screen.getByText("This computer may only be used in some projects, and none of them is available to you. Change where it is offered below.").id,
        );
    });

    it("starts with no project on a computer offered in any chat", async () => {
        renderLimited(undefined, undefined);

        expect(screen.queryByRole("combobox")).toBeNull();
        expect(startButton().disabled).toBe(false);
        expect(startButton().getAttribute("aria-describedby")).toBeNull();

        await userEvent.click(startButton());
        await waitFor(() => expect(startCalls).toHaveLength(1));
        expect(startCalls[0]).not.toHaveProperty("projectId");
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

    it("copies a report with the failure's category, never its text", async () => {
        const writeText = vi.fn(async (_text: string): Promise<void> => {});

        const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");

        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
        onTestFinished(() => {
            if (original === undefined) {
                Reflect.deleteProperty(navigator, "clipboard");
            } else {
                Object.defineProperty(navigator, "clipboard", original);
            }
        });
        bridge.connect.mockRejectedValueOnce(new Error("Permission denied (publickey). Enter passphrase for /Users/dana/.ssh/id_ed25519"));
        renderRow();

        await press(screen.getByRole("button", { name: "Connect" }));
        await waitFor(() => expect(screen.getByRole("status").textContent).toContain("passphrase"));
        await press(screen.getByRole("button", { name: "Copy diagnostics for build box" }));

        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
        expect(writeText.mock.calls[0]?.[0]).toContain("Last failure: login refused");
        expect(writeText.mock.calls[0]?.[0]).not.toContain("id_ed25519");
    });
});
