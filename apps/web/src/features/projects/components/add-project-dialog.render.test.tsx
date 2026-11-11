// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AddProjectDialog from "./add-project-dialog";

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { i18n: { _: (value: string) => value }, t };
        },
    };
});

const createProject = vi.fn(async (_args: unknown) => "project-1");
const registerDevice = vi.fn(async (_args: unknown) => {
    return { deviceId: "srv-new", secret: "s3cret" };
});
const revokeDevice = vi.fn(async (_args: unknown) => null);
const mutations: Record<string, (args: unknown) => Promise<unknown>> = { registerDevice, revokeDevice };

vi.mock("@tanstack/react-query", () => {
    return {
        useMutation: (options: { name: string }) => {
            return { mutateAsync: mutations[options.name] ?? createProject };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                devices: {
                    functions: {
                        registerDevice: {
                            mutationOptions: () => {
                                return { name: "registerDevice" };
                            },
                        },
                        revokeDevice: {
                            mutationOptions: () => {
                                return { name: "revokeDevice" };
                            },
                        },
                    },
                },
                projects: {
                    functions: {
                        createProject: {
                            mutationOptions: () => {
                                return { name: "createProject" };
                            },
                        },
                    },
                },
            };
        },
    };
});

const THIS_COMPUTER = /This computer/;
const OLD = /old/;
const NEW = /^new/;

const NEW_SPEC = { address: "new.example.com", identityFile: null, name: "new", port: 22, user: "me" };

const machines = [
    {
        disabledReason: null,
        id: "local",
        kind: "this-computer",
        label: "This computer",
        name: "This computer",
        spec: null,
        sshAlias: null,
        status: "this-computer",
    },
    {
        disabledReason: null,
        id: null,
        kind: "server",
        label: "SSH · box · not connected yet",
        name: "box",
        spec: null,
        sshAlias: "box",
        status: "not-connected",
    },
    {
        disabledReason: "Not paired on this computer",
        id: null,
        kind: "server",
        label: "SSH · old",
        name: "old",
        spec: null,
        sshAlias: "old",
        status: "unpaired",
    },
    {
        disabledReason: null,
        id: null,
        kind: "server",
        label: "SSH · new · not connected yet",
        name: "new",
        spec: NEW_SPEC,
        sshAlias: "new",
        status: "unpaired",
    },
];

const installBridge = () => {
    const device = {
        browseMachineFolders: vi.fn(async ({ path }: { path: string }) => {
            return { entries: [{ name: "app" }, { name: "docs" }], host: "This computer", next: null, parent: null, path: path === "" ? "/home/me" : path };
        }),
        connectAddProjectMachine: vi.fn(async () => {
            return { disabledReason: null, id: "srv-new", kind: "server", label: "Connected", name: "new", spec: null, sshAlias: "new", status: "connected" };
        }),
        createMachineFolder: vi.fn(),
        execute: vi.fn(),
        hostPair: vi.fn(async () => true),
        hostProbe: vi.fn(async () => {
            return { platform: "linux", sandboxAvailable: true, sandboxDetail: "", version: "0.0.0" };
        }),
        listAddProjectMachines: vi.fn(async () => machines),
        shareMachineFolder: vi.fn(async () => {
            return { shared: true };
        }),
    };

    vi.stubGlobal("neoreNative", {
        capabilities: ["device"],
        device,
        notify: async () => {},
        onCompose: () => () => {},
        takePendingCompose: async () => undefined,
    });

    return device;
};

beforeEach(() => {
    // jsdom has no Web Animations; the scroll area asks for the running ones.
    Element.prototype.getAnimations = () => [];
    // The dialog's scroll area needs a constructible ResizeObserver; the shared setup's is a plain function.
    vi.stubGlobal(
        "ResizeObserver",
        class {
            watching = 0;

            disconnect() {
                this.watching = 0;
            }

            observe() {
                this.watching += 1;
            }

            unobserve() {
                this.watching -= 1;
            }
        },
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
    createProject.mockClear();
    registerDevice.mockClear();
    revokeDevice.mockClear();
});

describe("AddProjectDialog", () => {
    it("lists the machines, disables a row with a reason and keeps the rows as buttons", async () => {
        installBridge();
        render(<AddProjectDialog onClose={() => {}} onCreateNew={() => {}} open />);

        const computer = await screen.findByRole("button", { name: THIS_COMPUTER });
        const old = screen.getByRole("button", { name: OLD });

        expect(computer).toHaveProperty("disabled", false);
        expect(old).toHaveProperty("disabled", true);
        expect(screen.getByText("Not paired on this computer")).toBeTruthy();
        expect(screen.getByText("Where is the project?")).toBeTruthy();
        expect(screen.getByText("SSH hosts come from ~/.ssh/config. Picking one connects it.")).toBeTruthy();
    });

    it("shows no spinner on a row while nothing is connecting", async () => {
        installBridge();
        render(<AddProjectDialog onClose={() => {}} onCreateNew={() => {}} open />);

        const computer = await screen.findByRole("button", { name: THIS_COMPUTER });

        // eslint-disable-next-line testing-library/no-node-access -- the spinner is an icon with no role, so its class is the only mark of it
        expect(computer.querySelector(".animate-spin")).toBeNull();
    });

    it("pairs an unpaired server as the Add a server form does, then browses it", async () => {
        const device = installBridge();

        render(<AddProjectDialog onClose={() => {}} onCreateNew={() => {}} open />);
        fireEvent.click(await screen.findByRole("button", { name: NEW }));

        expect(await screen.findByText("Add project on new")).toBeTruthy();
        expect(device.hostProbe).toHaveBeenCalledWith({ address: "new.example.com", name: "new", port: 22, user: "me" });
        expect(registerDevice).toHaveBeenCalledWith({ name: "new", platform: "linux", viaDeviceId: "local" });
        expect(device.hostPair).toHaveBeenCalledWith({
            deviceId: "srv-new",
            secret: "s3cret",
            spec: { address: "new.example.com", name: "new", port: 22, user: "me" },
        });
        expect(device.connectAddProjectMachine).toHaveBeenCalledWith("new");
        expect(revokeDevice).not.toHaveBeenCalled();
    });

    it("revokes the device it registered when the person declines the pairing", async () => {
        const device = installBridge();

        device.hostPair.mockResolvedValueOnce(false);
        render(<AddProjectDialog onClose={() => {}} onCreateNew={() => {}} open />);
        fireEvent.click(await screen.findByRole("button", { name: NEW }));

        expect(await screen.findByText("Cancelled on this computer.")).toBeTruthy();
        expect(revokeDevice).toHaveBeenCalledWith({ deviceId: "srv-new" });
        expect(device.connectAddProjectMachine).not.toHaveBeenCalled();
    });

    it("starts every opening at step one, not at the folder of the last session", async () => {
        installBridge();
        const { rerender } = render(<AddProjectDialog onClose={() => {}} onCreateNew={() => {}} open />);

        fireEvent.click(await screen.findByRole("button", { name: THIS_COMPUTER }));
        expect(await screen.findByText("Add project on This computer")).toBeTruthy();

        rerender(<AddProjectDialog onClose={() => {}} onCreateNew={() => {}} open={false} />);
        rerender(<AddProjectDialog onClose={() => {}} onCreateNew={() => {}} open />);

        expect(await screen.findByText("Where is the project?")).toBeTruthy();
    });

    it("browses a folder on this computer and adds the project titled with the folder's name", async () => {
        const device = installBridge();
        const onClose = vi.fn();

        render(<AddProjectDialog onClose={onClose} onCreateNew={() => {}} open />);
        fireEvent.click(await screen.findByRole("button", { name: THIS_COMPUTER }));

        expect(await screen.findByText("Add project on This computer")).toBeTruthy();
        fireEvent.click(await screen.findByRole("button", { name: "app" }));
        await waitFor(() => expect(device.browseMachineFolders).toHaveBeenCalledWith(expect.objectContaining({ path: "/home/me/app" })));
        await waitFor(() => expect((screen.getByLabelText("Folder path") as HTMLInputElement).value).toBe("/home/me/app"));

        fireEvent.click(screen.getByRole("button", { name: "Add project" }));

        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(createProject).toHaveBeenCalledWith({ machineId: "local", path: "/home/me/app", title: "app" });
        expect(device.shareMachineFolder).not.toHaveBeenCalled();
    });
});

const noop = () => {};

const settle = () =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });

const deferred = <T,>() => {
    const settler: { resolve: (value: T) => void } = { resolve: noop };
    const promise = new Promise<T>((resolve) => {
        settler.resolve = resolve;
    });

    return { promise, resolve: (value: T) => settler.resolve(value) };
};

const PAIRED_NOT_CONNECTED = {
    disabledReason: null,
    id: "srv-new",
    kind: "server",
    label: "SSH · new · not connected yet",
    name: "new",
    spec: null,
    sshAlias: "new",
    status: "not-connected",
};

const page = (path: string) => {
    return { entries: [], host: "This computer", next: null, parent: null, path };
};

describe("AddProjectDialog pairing and browsing guards", () => {
    it("keeps the row locked until the machine list has refreshed after pairing", async () => {
        const device = installBridge();
        const refresh = deferred<typeof machines>();

        device.listAddProjectMachines.mockResolvedValueOnce(machines).mockImplementationOnce(() => refresh.promise);
        render(<AddProjectDialog onClose={noop} onCreateNew={noop} open />);

        const row = await screen.findByRole("button", { name: NEW });

        fireEvent.click(row);
        await waitFor(() => expect(device.listAddProjectMachines).toHaveBeenCalledTimes(2));

        expect(row).toHaveProperty("disabled", true);
        fireEvent.click(row);
        await settle();
        expect(registerDevice).toHaveBeenCalledTimes(1);

        refresh.resolve(machines);
        expect(await screen.findByText("Add project on new")).toBeTruthy();
        expect(registerDevice).toHaveBeenCalledTimes(1);
    });

    it("does not start a second pairing for the same host after the dialog is closed and reopened", async () => {
        const device = installBridge();
        const pairing = deferred<boolean>();

        device.hostPair.mockImplementationOnce(() => pairing.promise);

        const { rerender } = render(<AddProjectDialog onClose={noop} onCreateNew={noop} open />);

        fireEvent.click(await screen.findByRole("button", { name: NEW }));
        await waitFor(() => expect(device.hostPair).toHaveBeenCalledTimes(1));

        rerender(<AddProjectDialog onClose={noop} onCreateNew={noop} open={false} />);
        rerender(<AddProjectDialog onClose={noop} onCreateNew={noop} open />);

        fireEvent.click(await screen.findByRole("button", { name: NEW }));
        await settle();

        expect(registerDevice).toHaveBeenCalledTimes(1);
        expect(device.hostProbe).toHaveBeenCalledTimes(1);

        pairing.resolve(true);
        await settle();
    });

    it("shows a paired server as paired and does not pair again when connecting failed after the pairing", async () => {
        const device = installBridge();

        device.connectAddProjectMachine.mockRejectedValueOnce(new Error("device: ssh failed"));
        device.listAddProjectMachines
            .mockResolvedValueOnce(machines)
            .mockResolvedValueOnce([...machines.slice(0, 3), PAIRED_NOT_CONNECTED] as unknown as typeof machines);
        render(<AddProjectDialog onClose={noop} onCreateNew={noop} open />);

        fireEvent.click(await screen.findByRole("button", { name: NEW }));
        expect(await screen.findByText("The desktop could not complete that. Try again.")).toBeTruthy();
        expect(device.hostPair).toHaveBeenCalledTimes(1);

        fireEvent.click(await screen.findByRole("button", { name: NEW }));
        expect(await screen.findByText("Add project on new")).toBeTruthy();
        expect(device.hostPair).toHaveBeenCalledTimes(1);
        expect(registerDevice).toHaveBeenCalledTimes(1);
        expect(device.connectAddProjectMachine).toHaveBeenCalledTimes(2);
    });

    it("drops a folder that arrives after Back and a second pick of the machine", async () => {
        const device = installBridge();
        const first = deferred<ReturnType<typeof page>>();

        device.browseMachineFolders.mockImplementationOnce(() => first.promise as never);
        render(<AddProjectDialog onClose={noop} onCreateNew={noop} open />);

        fireEvent.click(await screen.findByRole("button", { name: THIS_COMPUTER }));
        fireEvent.click(await screen.findByRole("button", { name: "Back" }));
        fireEvent.click(await screen.findByRole("button", { name: THIS_COMPUTER }));
        await waitFor(() => expect((screen.getByLabelText("Folder path") as HTMLInputElement).value).toBe("/home/me"));

        first.resolve(page("/stale"));
        await settle();

        expect((screen.getByLabelText("Folder path") as HTMLInputElement).value).toBe("/home/me");
    });

    it("drops the answer to an earlier path when a newer path was submitted", async () => {
        const device = installBridge();

        render(<AddProjectDialog onClose={noop} onCreateNew={noop} open />);
        fireEvent.click(await screen.findByRole("button", { name: THIS_COMPUTER }));
        await waitFor(() => expect((screen.getByLabelText("Folder path") as HTMLInputElement).value).toBe("/home/me"));

        const slow = deferred<ReturnType<typeof page>>();
        const input = screen.getByLabelText("Folder path");

        device.browseMachineFolders.mockImplementationOnce(() => slow.promise as never);
        fireEvent.change(input, { target: { value: "/a" } });
        fireEvent.submit(input);
        fireEvent.change(input, { target: { value: "/b" } });
        fireEvent.submit(input);
        await waitFor(() => expect((input as HTMLInputElement).value).toBe("/b"));

        slow.resolve(page("/a"));
        await settle();

        expect((input as HTMLInputElement).value).toBe("/b");
    });

    it("marks the path input invalid and describes it with the error after a path error", async () => {
        const device = installBridge();

        render(<AddProjectDialog onClose={noop} onCreateNew={noop} open />);
        fireEvent.click(await screen.findByRole("button", { name: THIS_COMPUTER }));
        await waitFor(() => expect((screen.getByLabelText("Folder path") as HTMLInputElement).value).toBe("/home/me"));

        const input = screen.getByLabelText("Folder path");

        device.browseMachineFolders.mockRejectedValueOnce(new Error("device: /nope is a file"));
        fireEvent.change(input, { target: { value: "/nope" } });
        fireEvent.submit(input);

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe("That path is a file.");
        expect(input.getAttribute("aria-invalid")).toBe("true");
        expect(input.getAttribute("aria-describedby")).toContain(alert.id);
        expect(input.getAttribute("aria-describedby")).toContain("add-project-path-hint");
    });

    it("does not mark the path input invalid for an error that is not about the path", async () => {
        const device = installBridge();

        render(<AddProjectDialog onClose={noop} onCreateNew={noop} open />);
        fireEvent.click(await screen.findByRole("button", { name: THIS_COMPUTER }));
        await waitFor(() => expect((screen.getByLabelText("Folder path") as HTMLInputElement).value).toBe("/home/me"));

        const input = screen.getByLabelText("Folder path");

        device.browseMachineFolders.mockRejectedValueOnce(new Error("device: connect the server first"));
        fireEvent.change(input, { target: { value: "/x" } });
        fireEvent.submit(input);

        expect(await screen.findByRole("alert")).toBeTruthy();
        expect(input.getAttribute("aria-invalid")).not.toBe("true");
    });

    it("keeps Add project disabled while the typed path differs from the folder that was opened", async () => {
        installBridge();
        render(<AddProjectDialog onClose={noop} onCreateNew={noop} open />);
        fireEvent.click(await screen.findByRole("button", { name: THIS_COMPUTER }));
        await waitFor(() => expect((screen.getByLabelText("Folder path") as HTMLInputElement).value).toBe("/home/me"));

        const add = screen.getByRole("button", { name: "Add project" });

        await waitFor(() => expect(add).toHaveProperty("disabled", false));
        fireEvent.change(screen.getByLabelText("Folder path"), { target: { value: "/elsewhere" } });
        expect(add).toHaveProperty("disabled", true);

        fireEvent.click(add);
        await settle();
        expect(createProject).not.toHaveBeenCalled();
    });

    it("does not register a second device when the list cannot be refreshed after pairing", async () => {
        const device = installBridge();

        device.connectAddProjectMachine.mockRejectedValueOnce(new Error("device: ssh failed"));
        device.listAddProjectMachines.mockResolvedValueOnce(machines).mockRejectedValueOnce(new Error("device: the desktop is busy"));
        render(<AddProjectDialog onClose={noop} onCreateNew={noop} open />);

        fireEvent.click(await screen.findByRole("button", { name: NEW }));
        expect(await screen.findByText("The desktop could not complete that. Try again.")).toBeTruthy();

        fireEvent.click(await screen.findByRole("button", { name: NEW }));
        expect(await screen.findByText("Add project on new")).toBeTruthy();
        expect(registerDevice).toHaveBeenCalledTimes(1);
        expect(device.hostPair).toHaveBeenCalledTimes(1);
        expect(device.connectAddProjectMachine).toHaveBeenCalledTimes(2);
    });
});
