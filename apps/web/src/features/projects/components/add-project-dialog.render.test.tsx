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

vi.mock("@tanstack/react-query", () => {
    return {
        useMutation: () => {
            return { mutateAsync: createProject };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                projects: {
                    functions: {
                        createProject: {
                            mutationOptions: () => {
                                return {};
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

const machines = [
    { disabledReason: null, id: "local", kind: "this-computer", label: "This computer", name: "This computer", sshAlias: null, status: "this-computer" },
    { disabledReason: null, id: null, kind: "server", label: "SSH · box · not connected yet", name: "box", sshAlias: "box", status: "not-connected" },
    { disabledReason: "Not paired on this computer", id: null, kind: "server", label: "SSH · old", name: "old", sshAlias: "old", status: "unpaired" },
];

const installBridge = () => {
    const device = {
        browseMachineFolders: vi.fn(async ({ path }: { path: string }) => {
            return { entries: [{ name: "app" }, { name: "docs" }], host: "This computer", next: null, parent: null, path: path === "" ? "/home/me" : path };
        }),
        connectAddProjectMachine: vi.fn(),
        createMachineFolder: vi.fn(),
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
