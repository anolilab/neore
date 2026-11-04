/**
 * The first-run setup checklist: state follows the device list, and skip / resume go through the server and show on screen.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SetupChecklist from "./setup-checklist";

const { devices, mutate, server, sonnerMock } = vi.hoisted(() => {
    return {
        devices: { current: [] as unknown[] },
        mutate: vi.fn(),
        server: { fail: false, skipped: undefined as string[] | undefined },
        sonnerMock: { toast: vi.fn() },
    };
});

vi.mock("sonner", () => {
    return { toast: { error: sonnerMock.toast } };
});

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
                                        mutate(args);

                                        if (server.fail) {
                                            throw new Error("down");
                                        }

                                        const rest = (server.skipped ?? []).filter((id) => id !== args.stepId);

                                        server.skipped = args.skipped ? [...rest, args.stepId] : rest;
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
                                return { queryFn: async () => devices.current, queryKey: ["listDevices"] };
                            },
                        },
                    },
                },
            };
        },
    };
});

const renderChecklist = () =>
    render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <SetupChecklist />
        </QueryClientProvider>,
    );

describe("<SetupChecklist>", () => {
    beforeEach(() => {
        devices.current = [];
        server.fail = false;
        server.skipped = undefined;
        mutate.mockClear();
        sonnerMock.toast.mockClear();
    });

    it("shows every step to do and shows Skipped, then Resume, after a click", async () => {
        renderChecklist();

        expect(await screen.findAllByText("(To do)")).toHaveLength(3);
        fireEvent.click(screen.getByRole("button", { name: /Skip.*Add an SSH server/ }));

        expect(await screen.findByText("(Skipped)")).toBeTruthy();
        expect(mutate).toHaveBeenCalledWith({ skipped: true, stepId: "ssh" });

        fireEvent.click(screen.getByRole("button", { name: /Resume.*Add an SSH server/ }));
        await waitFor(() => expect(screen.getAllByText("(To do)")).toHaveLength(3));
        expect(mutate).toHaveBeenLastCalledWith({ skipped: false, stepId: "ssh" });
    });

    it("keeps an earlier skip when a second step is skipped right after", async () => {
        renderChecklist();
        await screen.findAllByText("(To do)");
        fireEvent.click(screen.getByRole("button", { name: /Skip.*Add an SSH server/ }));
        fireEvent.click(screen.getByRole("button", { name: /Skip.*Install a coding agent/ }));

        await waitFor(() => expect(screen.getAllByText("(Skipped)")).toHaveLength(2));
        expect(mutate).toHaveBeenCalledTimes(2);
    });

    it("tells the user when a choice could not be saved", async () => {
        server.fail = true;
        renderChecklist();
        await screen.findAllByText("(To do)");
        fireEvent.click(screen.getByRole("button", { name: /Skip.*Add an SSH server/ }));

        await waitFor(() => expect(sonnerMock.toast).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(screen.getAllByText("(To do)")).toHaveLength(3));
    });

    it("does not call a step to do before the device list has loaded", async () => {
        renderChecklist();

        expect(screen.getAllByText("(Checking)")).toHaveLength(3);
        expect(screen.queryByRole("button", { name: /Skip/ })).toBeNull();
        expect(await screen.findAllByText("(To do)")).toHaveLength(3);
    });

    it("links each step to its control or guide", async () => {
        renderChecklist();
        await screen.findAllByText("(To do)");

        expect(screen.getByRole("link", { name: /Go to pairing/ }).getAttribute("href")).toBe("#devices-pairing");
        expect(screen.getByRole("link", { name: /Go to servers/ }).getAttribute("href")).toBe("#devices-ssh");
        expect(screen.getByRole("link", { name: /Read the guide/ }).getAttribute("href")).toBe("/docs/devices");
    });

    it("offers resume for a skipped step and drops it once its state appears", async () => {
        server.skipped = ["agent"];
        const { unmount } = renderChecklist();

        expect(await screen.findByRole("button", { name: /Resume.*Install a coding agent/ })).toBeTruthy();
        unmount();

        devices.current = [{ acpOffers: [{}] }];
        renderChecklist();
        expect((await screen.findAllByText("(Done)")).length).toBe(2);
        expect(screen.queryByRole("button", { name: /Resume/ })).toBeNull();
    });
});
