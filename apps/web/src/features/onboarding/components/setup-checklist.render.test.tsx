/**
 * The first-run setup checklist: state follows the device list, and skip / resume go through the server and show on screen.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SetupChecklist from "./setup-checklist";

const { devices, save, server, toastError } = vi.hoisted(() => {
    return {
        devices: { current: [] as unknown[], fail: false },
        save: vi.fn(),
        server: { failSave: false, skipped: [] as string[] },
        toastError: vi.fn(),
    };
});

vi.mock("sonner", () => {
    return { toast: { error: toastError } };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("@/components/settings/settings-card", () => {
    return {
        default: ({ children, title }: { children: React.ReactNode; title: string }) => <section aria-label={title}>{children}</section>,
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                auth: {
                    functions: {
                        getUserSettings: {
                            queryOptions: () => {
                                return {
                                    queryFn: async () => {
                                        return { setupStepsSkipped: server.skipped };
                                    },
                                    queryKey: ["getUserSettings"],
                                };
                            },
                        },
                    },
                    setup_steps: {
                        setSetupStepSkipped: {
                            mutationOptions: () => {
                                return {
                                    mutationFn: async (args: { skipped: boolean; stepId: string }) => {
                                        save(args);

                                        if (server.failSave) {
                                            throw new Error("down");
                                        }

                                        server.skipped = args.skipped ? [...server.skipped, args.stepId] : server.skipped.filter((id) => id !== args.stepId);

                                        return null;
                                    },
                                };
                            },
                        },
                    },
                },
                devices: {
                    functions: {
                        listDevices: {
                            queryOptions: () => {
                                return {
                                    queryFn: async () => {
                                        if (devices.fail) {
                                            throw new Error("offline");
                                        }

                                        return devices.current;
                                    },
                                    queryKey: ["listDevices"],
                                };
                            },
                        },
                    },
                },
            };
        },
    };
});

const RESkip = /Skip/;
const REGoToPairing = /Go to pairing/;
const REGoToServers = /Go to servers/;
const REReadTheGuide = /Read the guide/;
const RESkipAddAnSshServer = /Skip: Add an SSH server/;
const REResumeAddAnSshServer = /Resume: Add an SSH server/;
const RESkipPairAComputer = /Skip: Pair a computer/;
const RESkipResume = /Skip|Resume/;
const RECouldNotReadYourDevices = /Could not read your devices/;

const renderChecklist = () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });

    render(
        <QueryClientProvider client={client}>
            <SetupChecklist />
        </QueryClientProvider>,
    );
};

describe("<SetupChecklist>", () => {
    beforeEach(() => {
        devices.current = [];
        devices.fail = false;
        server.failSave = false;
        server.skipped = [];
        save.mockClear();
        toastError.mockClear();
    });

    it("shows no status until both reads answer, then every step to do with a link to its control or guide", async () => {
        renderChecklist();

        expect(screen.getAllByText("(Checking)")).toHaveLength(3);
        expect(screen.queryByRole("button", { name: RESkip })).toBeNull();

        expect(await screen.findAllByText("(To do)")).toHaveLength(3);
        expect(screen.getByRole("link", { name: REGoToPairing }).getAttribute("href")).toBe("#devices-pairing");
        expect(screen.getByRole("link", { name: REGoToServers }).getAttribute("href")).toBe("#devices-ssh");
        expect(screen.getByRole("link", { name: REReadTheGuide }).getAttribute("href")).toBe("/docs/devices#coding-agents-on-a-computer");
    });

    it("skips and resumes a step through the server", async () => {
        const user = userEvent.setup();

        renderChecklist();
        await user.click(await screen.findByRole("button", { name: RESkipAddAnSshServer }));

        expect(await screen.findByText("(Skipped)")).toBeTruthy();
        expect(save).toHaveBeenCalledWith({ skipped: true, stepId: "ssh" });

        await user.click(screen.getByRole("button", { name: REResumeAddAnSshServer }));

        await waitFor(() => {
            expect(screen.queryByText("(Skipped)")).toBeNull();
        });
        expect(save).toHaveBeenLastCalledWith({ skipped: false, stepId: "ssh" });
    });

    it("puts the step back and says so when the save fails", async () => {
        const user = userEvent.setup();

        server.failSave = true;
        renderChecklist();
        await user.click(await screen.findByRole("button", { name: RESkipPairAComputer }));

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe("Could not save that choice. Try again.");
        expect(toastError).toHaveBeenCalled();
        expect(screen.queryByText("(Skipped)")).toBeNull();
    });

    it("completes steps from the device list, and done wins over a stored skip", async () => {
        devices.current = [{ transport: "ssh" }, { acpOffers: [{}] }];
        server.skipped = ["pair"];
        renderChecklist();

        expect(await screen.findAllByText("(Done)")).toHaveLength(3);
        expect(screen.queryByRole("button", { name: RESkipResume })).toBeNull();
        expect(screen.queryByRole("link")).toBeNull();
    });

    it("keeps the links when the device check fails, and retries it", async () => {
        const user = userEvent.setup();

        devices.fail = true;
        renderChecklist();

        expect(await screen.findByText(RECouldNotReadYourDevices)).toBeTruthy();
        expect(screen.getByRole("link", { name: REGoToPairing })).toBeTruthy();
        expect(screen.queryByRole("button", { name: RESkip })).toBeNull();

        devices.fail = false;
        await user.click(screen.getByRole("button", { name: "Retry the device check" }));

        expect(await screen.findAllByText("(To do)")).toHaveLength(3);
    });
});
