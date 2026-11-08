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
                                return { queryFn: async () => ({ setupStepsSkipped: server.skipped }), queryKey: ["getUserSettings"] };
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
        expect(screen.queryByRole("button", { name: /Skip/ })).toBeNull();

        expect(await screen.findAllByText("(To do)")).toHaveLength(3);
        expect(screen.getByRole("link", { name: /Go to pairing/ }).getAttribute("href")).toBe("#devices-pairing");
        expect(screen.getByRole("link", { name: /Go to servers/ }).getAttribute("href")).toBe("#devices-ssh");
        expect(screen.getByRole("link", { name: /Read the guide/ }).getAttribute("href")).toBe("/docs/devices#coding-agents-on-a-computer");
    });

    it("skips and resumes a step through the server", async () => {
        const user = userEvent.setup();

        renderChecklist();
        await user.click(await screen.findByRole("button", { name: /Skip: Add an SSH server/ }));

        expect(await screen.findByText("(Skipped)")).toBeTruthy();
        expect(save).toHaveBeenCalledWith({ skipped: true, stepId: "ssh" });

        await user.click(screen.getByRole("button", { name: /Resume: Add an SSH server/ }));

        await waitFor(() => {
            expect(screen.queryByText("(Skipped)")).toBeNull();
        });
        expect(save).toHaveBeenLastCalledWith({ skipped: false, stepId: "ssh" });
    });

    it("puts the step back and says so when the save fails", async () => {
        const user = userEvent.setup();

        server.failSave = true;
        renderChecklist();
        await user.click(await screen.findByRole("button", { name: /Skip: Pair a computer/ }));

        expect((await screen.findByRole("alert")).textContent).toBe("Could not save that choice. Try again.");
        expect(toastError).toHaveBeenCalled();
        expect(screen.queryByText("(Skipped)")).toBeNull();
    });

    it("completes steps from the device list, and done wins over a stored skip", async () => {
        devices.current = [{ transport: "ssh" }, { acpOffers: [{}] }];
        server.skipped = ["pair"];
        renderChecklist();

        expect(await screen.findAllByText("(Done)")).toHaveLength(3);
        expect(screen.queryByRole("button", { name: /Skip|Resume/ })).toBeNull();
        expect(screen.queryByRole("link")).toBeNull();
    });

    it("keeps the links when the device check fails, and retries it", async () => {
        const user = userEvent.setup();

        devices.fail = true;
        renderChecklist();

        expect(await screen.findByText(/Could not read your devices/)).toBeTruthy();
        expect(screen.getByRole("link", { name: /Go to pairing/ })).toBeTruthy();
        expect(screen.queryByRole("button", { name: /Skip/ })).toBeNull();

        devices.fail = false;
        await user.click(screen.getByRole("button", { name: "Retry the device check" }));

        expect(await screen.findAllByText("(To do)")).toHaveLength(3);
    });
});
