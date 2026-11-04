/**
 * The first-run setup checklist: state follows the device list, and skip / resume go through the server and show on screen.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SetupChecklist from "./setup-checklist";

const { devices, mutate, server, sonnerMock } = vi.hoisted(() => {
    return {
        devices: { current: [] as unknown[], fail: false },
        mutate: vi.fn(),
        server: { fail: false, readFail: false, hold: undefined as Promise<void> | undefined, noRow: false, skipped: undefined as string[] | undefined },
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
                                return {
                                    queryFn: async () => {
                                        if (server.readFail) {
                                            throw new Error("offline");
                                        }

                                        return server.noRow ? null : { setupStepsSkipped: server.skipped };
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
                                        mutate(args);

                                        await server.hold;

                                        if (server.fail) {
                                            throw new Error("down");
                                        }

                                        server.noRow = false;

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

const SKIP_ADD_AN_SSH_SERVER = /Skip.*Add an SSH server/;
const RESUME_ADD_AN_SSH_SERVER = /Resume.*Add an SSH server/;
const SKIP_INSTALL_A_CODING_AGENT = /Skip.*Install a coding agent/;
const RESUME_PAIR_A_COMPUTER = /Resume.*Pair a computer/;
const PAIR_THIS_COMPUTER = /Pair this computer/;
const SKIP = /Skip/;
const RETRY = /^Retry$/;
const RETRY_DEVICES = /Retry the device check/;
const COULD_NOT_READ_DEVICES = /Could not read your devices/;
const COULD_NOT_LOAD = /Could not load your saved choices/;
const GO_TO_PAIRING = /Go to pairing/;
const GO_TO_SERVERS = /Go to servers/;
const READ_THE_GUIDE = /Read the guide/;
const RESUME_INSTALL_A_CODING_AGENT = /Resume.*Install a coding agent/;
const RESUME = /Resume/;

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const renderChecklist = (client = newClient()) =>
    render(
        <QueryClientProvider client={client}>
            <SetupChecklist />
        </QueryClientProvider>,
    );

describe("<SetupChecklist>", () => {
    beforeEach(() => {
        devices.current = [];
        devices.fail = false;
        server.fail = false;
        server.readFail = false;
        server.hold = undefined;
        server.noRow = false;
        server.skipped = undefined;
        mutate.mockClear();
        sonnerMock.toast.mockClear();
    });

    it("shows every step to do and shows Skipped, then Resume, after a click", async () => {
        renderChecklist();

        expect(await screen.findAllByText("(To do)")).toHaveLength(3);
        fireEvent.click(screen.getByRole("button", { name: SKIP_ADD_AN_SSH_SERVER }));

        expect(await screen.findByText("(Skipped)")).toBeTruthy();
        expect(mutate).toHaveBeenCalledWith({ skipped: true, stepId: "ssh" });

        fireEvent.click(screen.getByRole("button", { name: RESUME_ADD_AN_SSH_SERVER }));
        await waitFor(() => expect(screen.getAllByText("(To do)")).toHaveLength(3));
        expect(mutate).toHaveBeenLastCalledWith({ skipped: false, stepId: "ssh" });
    });

    it("shows a first skip for an account with no settings row yet", async () => {
        server.noRow = true;
        renderChecklist();
        await screen.findAllByText("(To do)");
        fireEvent.click(screen.getByRole("button", { name: SKIP_ADD_AN_SSH_SERVER }));

        expect(await screen.findByText("(Skipped)")).toBeTruthy();
        expect(mutate).toHaveBeenCalledWith({ skipped: true, stepId: "ssh" });
        expect(server.skipped).toEqual(["ssh"]);
    });

    it("shows what the server saved after a failed save, not the click", async () => {
        server.skipped = ["pair"];
        server.fail = true;
        renderChecklist();
        await screen.findByText("(Skipped)");
        fireEvent.click(screen.getByRole("button", { name: SKIP_ADD_AN_SSH_SERVER }));

        await waitFor(() => expect(sonnerMock.toast).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(screen.getAllByText("(Skipped)")).toHaveLength(1));
        expect(screen.getByRole("button", { name: RESUME_PAIR_A_COMPUTER })).toBeTruthy();
        expect(server.skipped).toEqual(["pair"]);
    });

    it("shows a saved skip after a reload", async () => {
        const view = renderChecklist();

        await screen.findAllByText("(To do)");
        fireEvent.click(screen.getByRole("button", { name: SKIP_ADD_AN_SSH_SERVER }));
        await screen.findByText("(Skipped)");
        view.unmount();

        renderChecklist();
        expect(await screen.findByText("(Skipped)")).toBeTruthy();
        expect(screen.getByRole("button", { name: RESUME_ADD_AN_SSH_SERVER })).toBeTruthy();
    });

    it("shows the skip when a settings read that began before the click lands after it", async () => {
        let release = () => {};

        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- `Promise.withResolvers` is newer than the supported runtimes
        server.hold = new Promise<void>((resolve) => {
            release = resolve;
        });

        const client = newClient();

        renderChecklist(client);
        await screen.findAllByText("(To do)");
        fireEvent.click(screen.getByRole("button", { name: SKIP_ADD_AN_SSH_SERVER }));
        await client.refetchQueries({ queryKey: ["getUserSettings"] });
        release();

        expect(await screen.findByText("(Skipped)")).toBeTruthy();
    });

    it("explains a failed settings read and retries it", async () => {
        server.readFail = true;
        renderChecklist();

        expect(await screen.findByText(COULD_NOT_LOAD)).toBeTruthy();
        expect((screen.getAllByRole("button", { name: SKIP })[0] as HTMLButtonElement).disabled).toBe(true);

        server.readFail = false;
        fireEvent.click(screen.getByRole("button", { name: RETRY }));

        await waitFor(() => expect(screen.queryByText(COULD_NOT_LOAD)).toBeNull());
        expect((screen.getAllByRole("button", { name: SKIP })[0] as HTMLButtonElement).disabled).toBe(false);
    });

    it("keeps the pairing and server links when the device check fails, and retries it", async () => {
        devices.fail = true;
        renderChecklist();

        expect(await screen.findByText(COULD_NOT_READ_DEVICES)).toBeTruthy();
        expect(screen.getByRole("link", { name: GO_TO_PAIRING }).getAttribute("href")).toBe("#devices-pairing");
        expect(screen.getByRole("link", { name: GO_TO_SERVERS }).getAttribute("href")).toBe("#devices-ssh");
        expect(screen.queryByRole("button", { name: SKIP })).toBeNull();

        devices.fail = false;
        fireEvent.click(screen.getByRole("button", { name: RETRY_DEVICES }));

        expect(await screen.findAllByText("(To do)")).toHaveLength(3);
        expect(screen.queryByText(COULD_NOT_READ_DEVICES)).toBeNull();
    });

    it("reverts the click and says so when the save fails and the stored list cannot be re-read", async () => {
        server.fail = true;
        renderChecklist();
        await screen.findAllByText("(To do)");
        server.readFail = true;
        fireEvent.click(screen.getByRole("button", { name: SKIP_ADD_AN_SSH_SERVER }));

        await waitFor(() => expect(sonnerMock.toast).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(screen.getAllByText("(To do)")).toHaveLength(3));
        expect(screen.queryByText("(Skipped)")).toBeNull();
    });

    it("lets the latest click win when Resume follows a Skip that has not been saved yet", async () => {
        let release = () => {};

        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- `Promise.withResolvers` is newer than the supported runtimes
        server.hold = new Promise<void>((resolve) => {
            release = resolve;
        });
        renderChecklist();
        await screen.findAllByText("(To do)");
        fireEvent.click(screen.getByRole("button", { name: SKIP_ADD_AN_SSH_SERVER }));
        fireEvent.click(await screen.findByRole("button", { name: RESUME_ADD_AN_SSH_SERVER }));

        // The Resume waits behind the Skip instead of racing it.
        await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
        server.hold = undefined;
        release();

        await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
        expect(mutate.mock.calls.map(([args]) => args)).toEqual([
            { skipped: true, stepId: "ssh" },
            { skipped: false, stepId: "ssh" },
        ]);
        await waitFor(() => expect(screen.getAllByText("(To do)")).toHaveLength(3));
        expect(server.skipped ?? []).toEqual([]);
    });

    it("keeps showing the last saved state with the error, and turns Skip off, when a refresh fails", async () => {
        server.skipped = ["pair"];
        const client = newClient();

        renderChecklist(client);
        await screen.findByText("(Skipped)");

        server.readFail = true;
        await client.refetchQueries({ queryKey: ["getUserSettings"] });

        expect(await screen.findByText(COULD_NOT_LOAD)).toBeTruthy();
        expect(screen.getByText("(Skipped)")).toBeTruthy();
        expect((screen.getByRole("button", { name: SKIP_ADD_AN_SSH_SERVER }) as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByRole("button", { name: RESUME_PAIR_A_COMPUTER }) as HTMLButtonElement).disabled).toBe(true);

        server.readFail = false;
        fireEvent.click(screen.getByRole("button", { name: RETRY }));

        await waitFor(() => expect((screen.getByRole("button", { name: SKIP_ADD_AN_SSH_SERVER }) as HTMLButtonElement).disabled).toBe(false));
    });

    it("counts the pairing step done when another computer is paired, and words it for any computer", async () => {
        // The page cannot tell which computer it runs on; a computer paired with the account is what counts.
        devices.current = [{ _id: "other-laptop", name: "Other laptop" }];
        renderChecklist();

        expect(await screen.findByText("Pair a computer")).toBeTruthy();
        expect(await screen.findAllByText("(Done)")).not.toHaveLength(0);
        expect(screen.queryByText(PAIR_THIS_COMPUTER)).toBeNull();
        expect(screen.queryByRole("link", { name: GO_TO_PAIRING })).toBeNull();
    });

    it("keeps an earlier skip when a second step is skipped right after", async () => {
        renderChecklist();
        await screen.findAllByText("(To do)");
        fireEvent.click(screen.getByRole("button", { name: SKIP_ADD_AN_SSH_SERVER }));
        fireEvent.click(screen.getByRole("button", { name: SKIP_INSTALL_A_CODING_AGENT }));

        await waitFor(() => expect(screen.getAllByText("(Skipped)")).toHaveLength(2));
        expect(mutate).toHaveBeenCalledTimes(2);
    });

    it("tells the user when a choice could not be saved", async () => {
        server.fail = true;
        renderChecklist();
        await screen.findAllByText("(To do)");
        fireEvent.click(screen.getByRole("button", { name: SKIP_ADD_AN_SSH_SERVER }));

        await waitFor(() => expect(sonnerMock.toast).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(screen.getAllByText("(To do)")).toHaveLength(3));
    });

    it("does not call a step to do before the device list has loaded", async () => {
        renderChecklist();

        expect(screen.getAllByText("(Checking)")).toHaveLength(3);
        expect(screen.queryByRole("button", { name: SKIP })).toBeNull();
        expect(await screen.findAllByText("(To do)")).toHaveLength(3);
    });

    it("links each step to its control or guide", async () => {
        renderChecklist();
        await screen.findAllByText("(To do)");

        expect(screen.getByRole("link", { name: GO_TO_PAIRING }).getAttribute("href")).toBe("#devices-pairing");
        expect(screen.getByRole("link", { name: GO_TO_SERVERS }).getAttribute("href")).toBe("#devices-ssh");
        expect(screen.getByRole("link", { name: READ_THE_GUIDE }).getAttribute("href")).toBe("/docs/devices#coding-agents-on-a-computer");
    });

    it("offers resume for a skipped step and drops it once its state appears", async () => {
        server.skipped = ["agent"];
        const { unmount } = renderChecklist();

        expect(await screen.findByRole("button", { name: RESUME_INSTALL_A_CODING_AGENT })).toBeTruthy();
        unmount();

        devices.current = [{ acpOffers: [{}] }];
        renderChecklist();
        expect(await screen.findAllByText("(Done)")).toHaveLength(2);
        expect(screen.queryByRole("button", { name: RESUME })).toBeNull();
    });
});
