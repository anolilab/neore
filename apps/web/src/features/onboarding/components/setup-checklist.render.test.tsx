/**
 * The first-run setup checklist: state follows the device list, and skip / resume go through the server and show on screen.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SetupChecklist from "./setup-checklist";

const { account, devices, save, server, toastError } = vi.hoisted(() => {
    return {
        account: { id: "user-a" },
        devices: { current: [] as unknown[], fail: false, hold: undefined as Promise<undefined> | undefined, reads: 0 },
        save: vi.fn(),
        server: {
            failSave: false,
            failStep: undefined as string | undefined,
            noRow: false,
            reads: 0,
            hold: undefined as Promise<undefined> | undefined,
            settingsHold: undefined as Promise<undefined> | undefined,
            skipped: [] as string[],
        },
        toastError: vi.fn(),
    };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                authClient: {
                    getSession: async () => {
                        return { data: { user: { id: account.id } } };
                    },
                    useSession: () => {
                        return { data: { user: { id: account.id } } };
                    },
                },
            };
        },
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
                                        server.reads += 1;
                                        await server.settingsHold;

                                        if (server.noRow) {
                                            return null;
                                        }

                                        return { setupStepsSkipped: [...server.skipped] };
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

                                        await server.hold;

                                        if (server.failSave || server.failStep === args.stepId) {
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
                                        devices.reads += 1;
                                        await devices.hold;

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

/** A promise a test holds shut until it calls `open`. */
const createGate = () => {
    let open: () => void = () => {};
    // The tsconfig lib predates `Promise.withResolvers`.

    const promise = new Promise<undefined>((resolve) => {
        open = () => {
            resolve(undefined);
        };
    });

    return { open, promise };
};

const renderChecklist = (serverFormShown = true, client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })) => {
    const tree = (
        <QueryClientProvider client={client}>
            <SetupChecklist serverFormShown={serverFormShown} />
        </QueryClientProvider>
    );

    render(tree);
};

describe("<SetupChecklist>", () => {
    beforeEach(() => {
        devices.current = [];
        devices.fail = false;
        devices.reads = 0;
        devices.hold = undefined;
        account.id = "user-a";
        server.failSave = false;
        server.failStep = undefined;
        server.noRow = false;
        server.reads = 0;
        server.hold = undefined;
        server.settingsHold = undefined;
        server.skipped = [];
        save.mockClear();
        toastError.mockClear();
    });

    it("shows no status while the settings read is pending, so a stored skip never reads as To do", async () => {
        const gate = createGate();

        server.settingsHold = gate.promise;
        server.skipped = ["ssh"];
        renderChecklist();
        await waitFor(() => {
            expect(devices.reads).toBeGreaterThan(0);
        });

        expect(screen.getAllByText("(Checking)")).toHaveLength(3);
        expect(screen.queryByRole("button", { name: RESkip })).toBeNull();

        gate.open();

        expect(await screen.findByText("(Skipped)")).toBeTruthy();
        expect(screen.getAllByText("(To do)")).toHaveLength(2);
    });

    it("links the pairing step and the guide, and the servers step only when its card is on the page", async () => {
        renderChecklist(false);

        expect(await screen.findAllByText("(To do)")).toHaveLength(3);
        expect(screen.getByRole("link", { name: REGoToPairing }).getAttribute("href")).toBe("#devices-pairing");
        expect(screen.getByRole("link", { name: REReadTheGuide }).getAttribute("href")).toBe("/docs/devices#coding-agents-on-a-computer");
        expect(screen.queryByRole("link", { name: REGoToServers })).toBeNull();
    });

    it("links the servers step to its card when the card is on the page", async () => {
        renderChecklist(true);

        const link = await screen.findByRole("link", { name: REGoToServers });

        expect(link.getAttribute("href")).toBe("#devices-ssh");
    });

    it("skips and resumes a step through the server", async () => {
        const user = userEvent.setup();

        renderChecklist();
        await user.click(await screen.findByRole("button", { name: RESkipAddAnSshServer }));

        expect(await screen.findByText("(Skipped)")).toBeTruthy();
        expect(save).toHaveBeenCalledWith({ expectedUserId: "user-a", skipped: true, stepId: "ssh" });

        await user.click(screen.getByRole("button", { name: REResumeAddAnSshServer }));

        await waitFor(() => {
            expect(screen.queryByText("(Skipped)")).toBeNull();
        });
        expect(save).toHaveBeenLastCalledWith({ expectedUserId: "user-a", skipped: false, stepId: "ssh" });
    });

    it("puts the step back and says so when the save fails", async () => {
        const user = userEvent.setup();

        server.failSave = true;
        renderChecklist();
        await user.click(await screen.findByRole("button", { name: RESkipPairAComputer }));

        expect(await screen.findByText("Could not save that choice. Try again.")).toBeTruthy();
        expect(toastError).toHaveBeenCalledTimes(1);
        expect(screen.queryByText("(Skipped)")).toBeNull();
    });

    it("completes steps from the device list, and done wins over a stored skip", async () => {
        devices.current = [
            { lastSeenAt: 1, transport: "ssh" },
            { acpOffers: [{}], lastSeenAt: 1 },
        ];
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

    it("ends on the stored state when the same step fails to save twice", async () => {
        const user = userEvent.setup();

        server.skipped = ["ssh"];
        server.failSave = true;
        renderChecklist();
        await user.click(await screen.findByRole("button", { name: REResumeAddAnSshServer }));
        await waitFor(() => {
            expect(save).toHaveBeenCalledTimes(1);
        });
        await user.click(await screen.findByRole("button", { name: REResumeAddAnSshServer }));
        await waitFor(() => {
            expect(save).toHaveBeenCalledTimes(2);
        });

        expect(await screen.findByText("(Skipped)")).toBeTruthy();
        expect(screen.getAllByText("(To do)")).toHaveLength(2);
    });

    it("refuses a queued save once the signed-in account has changed, and announces nothing", async () => {
        const user = userEvent.setup();
        const gate = createGate();

        const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });

        server.hold = gate.promise;
        renderChecklist(true, client);
        await user.click(await screen.findByRole("button", { name: RESkipAddAnSshServer }));
        await user.click(screen.getByRole("button", { name: RESkipPairAComputer }));
        // The session changes between the two clicks; the card is not re-rendered.
        account.id = "user-b";
        gate.open();

        // Drained: both saves have settled, the second without being sent.
        await waitFor(() => {
            expect(client.isMutating()).toBe(0);
        });

        expect(save).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenCalledWith({ expectedUserId: "user-a", skipped: true, stepId: "ssh" });
        expect(save).not.toHaveBeenCalledWith(expect.objectContaining({ stepId: "pair" }));
        expect(toastError).not.toHaveBeenCalled();
    });

    it("keeps the second step's choice when the first of two quick saves fails, and re-reads once", async () => {
        const user = userEvent.setup();
        const gate = createGate();

        server.hold = gate.promise;
        server.failStep = "pair";
        renderChecklist();
        await user.click(await screen.findByRole("button", { name: RESkipPairAComputer }));
        await user.click(screen.getByRole("button", { name: RESkipAddAnSshServer }));
        gate.open();

        await waitFor(() => {
            expect(save).toHaveBeenCalledTimes(2);
        });
        await waitFor(() => {
            expect(server.skipped).toEqual(["ssh"]);
        });

        expect(await screen.findByText("(Skipped)")).toBeTruthy();
        expect(screen.getAllByText("(To do)")).toHaveLength(2);
        // The first read plus one after the last save settled, none while the second save was still waiting.
        await waitFor(() => {
            expect(server.reads).toBe(2);
        });
    });

    it("shows a first skip for an account with no settings row, and puts the null back when it fails", async () => {
        const user = userEvent.setup();
        const gate = createGate();

        server.noRow = true;
        server.hold = gate.promise;
        renderChecklist();
        await user.click(await screen.findByRole("button", { name: RESkipAddAnSshServer }));

        expect(await screen.findByText("(Skipped)")).toBeTruthy();

        server.failSave = true;
        gate.open();

        await waitFor(() => {
            expect(screen.queryByText("(Skipped)")).toBeNull();
        });
        expect(screen.getAllByText("(To do)")).toHaveLength(3);
    });

    it("says a status change in a polite region, and nothing on the first read", async () => {
        const user = userEvent.setup();

        renderChecklist();
        await screen.findAllByText("(To do)");

        const region = screen.getByRole("status");

        expect(region.textContent).toBe("");

        await user.click(screen.getByRole("button", { name: RESkipAddAnSshServer }));

        await waitFor(() => {
            expect(region.textContent).toBe("Add an SSH server is skipped.");
        });
    });

    it("shows statuses at once when the app shell already cached both reads and nothing refetches them", async () => {
        // `crpc` queries have an infinite staleTime: a cached read is never fetched again on mount.
        const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false, staleTime: Infinity } } });

        client.setQueryData(["getUserSettings"], { setupStepsSkipped: ["ssh"] });
        client.setQueryData(["listDevices"], [{ lastSeenAt: 1 }]);
        renderChecklist(true, client);

        expect(await screen.findByText("(Skipped)")).toBeTruthy();
        expect(screen.getByText("(Done)")).toBeTruthy();
        expect(screen.getByText("(To do)")).toBeTruthy();
        expect(devices.reads).toBe(0);
    });
});
