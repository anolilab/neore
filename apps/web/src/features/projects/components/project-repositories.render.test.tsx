import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import ProjectRepositories from "./project-repositories";

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

const backend = vi.hoisted(() => {
    return {
        add: vi.fn(),
        // What `listProjectRepos` answers; a test adds to it to stand for another member's change.
        listed: [{ defaultBranch: "develop", id: "r1", isDefault: true, revision: 0, url: "https://github.com/acme/web.git" }] as unknown[],
        listReads: 0,
        // The next read of the list fails, once.
        listFails: false,
        update: vi.fn(),
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    const query = (name: string, data: unknown) => {
        return {
            queryKey: (args: unknown) => [name, args],
            queryOptions: (args: unknown) => {
                return {
                    queryFn: async () => {
                        if (name === "listProjectRepos") {
                            backend.listReads += 1;

                            if (backend.listFails) {
                                backend.listFails = false;

                                throw new Error("network");
                            }

                            return [...backend.listed];
                        }

                        return data;
                    },
                    queryKey: [name, args],
                };
            },
        };
    };
    const mutation = (run: unknown) => {
        return {
            mutationOptions: () => {
                return { mutationFn: run };
            },
        };
    };

    return {
        useCRPC: () => {
            return {
                projects: {
                    functions: {
                        addProjectRepo: mutation(backend.add),
                        getProject: query("getProject", { _id: "p1", title: "Web", userId: "owner" }),
                        listProjectRepos: query("listProjectRepos", [
                            { defaultBranch: "develop", id: "r1", isDefault: true, revision: 0, url: "https://github.com/acme/web.git" },
                        ]),
                        removeProjectRepo: mutation(vi.fn()),
                        setDefaultProjectRepo: mutation(vi.fn()),
                        updateProjectRepo: mutation(backend.update),
                    },
                },
            };
        },
    };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                hooks: {
                    useSession: () => {
                        return { data: { user: { id: "owner" } } };
                    },
                },
            };
        },
    };
});

const renderSection = () =>
    render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <ProjectRepositories projectId="p1" />
        </QueryClientProvider>,
    );

describe("ProjectRepositories", () => {
    it("clears a listed repository's default branch from the keyboard", async () => {
        backend.update.mockResolvedValue(null);
        renderSection();

        const branch = await screen.findByRole("textbox", { name: "Default branch of acme/web" });

        branch.focus();
        fireEvent.change(branch, { target: { value: "" } });
        fireEvent.keyDown(branch, { key: "Enter" });

        await vi.waitFor(() => expect(backend.update).toHaveBeenCalledWith({ defaultBranch: "", repoId: "r1", revision: 0 }, expect.anything()));
        expect(backend.update).toHaveBeenCalledOnce();
    });

    it("keeps focus on the next control when Tab leaves an edited branch, while it saves", async () => {
        // Still saving: the promise never settles.
        backend.update.mockReturnValue(
            new Promise(() => {
                // Never settles.
            }),
        );
        renderSection();

        const user = userEvent.setup();
        const branch = await screen.findByRole("textbox", { name: "Default branch of acme/web" });

        await user.clear(branch);
        await user.type(branch, "main");
        await user.tab();

        const next = screen.getByRole("button", { name: "Remove acme/web" });

        await vi.waitFor(() => expect(backend.update).toHaveBeenCalledOnce());
        // eslint-disable-next-line testing-library/no-node-access -- focus placement is what this test asserts
        expect(document.activeElement).toBe(next);
        expect((next as HTMLButtonElement).disabled).toBe(false);
    });

    it("shows a refused branch on its own row, not on the Add form", async () => {
        backend.update.mockRejectedValue(Object.assign(new Error("bad"), { data: { field: "defaultBranch", reason: "invalidBranch" } }));
        renderSection();

        const branch = await screen.findByRole("textbox", { name: "Default branch of acme/web" });

        fireEvent.change(branch, { target: { value: "x..y" } });
        fireEvent.blur(branch);

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe("This is not a valid branch name.");
        expect(branch.getAttribute("aria-invalid")).toBe("true");
        expect(branch.getAttribute("aria-describedby")).toBe(alert.id);
        expect(screen.getByRole("textbox", { name: "Default branch" }).getAttribute("aria-invalid")).toBe("false");
    });

    it("shows a refusal in the person's language, on the field it names", async () => {
        backend.add.mockRejectedValue(
            Object.assign(new Error('"x..y" is not a valid branch name'), { data: { field: "defaultBranch", reason: "invalidBranch" } }),
        );

        renderSection();

        fireEvent.change(await screen.findByRole("textbox", { name: "Repository" }), { target: { value: "acme/web" } });
        fireEvent.change(screen.getByRole("textbox", { name: "Default branch" }), { target: { value: "x..y" } });
        fireEvent.click(screen.getByRole("button", { name: "Add" }));

        const alert = await screen.findByRole("alert");
        const branch = screen.getByRole("textbox", { name: "Default branch" });

        expect(alert.textContent).toBe("This is not a valid branch name.");
        expect(branch.getAttribute("aria-invalid")).toBe("true");
        expect(branch.getAttribute("aria-describedby")).toBe(alert.id);
        expect(screen.getByRole("textbox", { name: "Repository" }).getAttribute("aria-invalid")).toBe("false");
    });

    it("reads the list again once an added repository lands", async () => {
        backend.add.mockResolvedValue("r2");
        backend.listReads = 0;
        renderSection();

        fireEvent.change(await screen.findByRole("textbox", { name: "Repository" }), { target: { value: "acme/api" } });
        await vi.waitFor(() => expect(backend.listReads).toBe(1));
        fireEvent.click(screen.getByRole("button", { name: "Add" }));

        await vi.waitFor(() => expect(backend.listReads).toBe(2));
    });

    it("reads the list again while the settings stay open, for another member's changes", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        try {
            backend.listReads = 0;
            renderSection();
            await vi.waitFor(() => expect(backend.listReads).toBe(1));
            expect(screen.queryByText("acme/docs")).toBeNull();

            // Another member adds a repository meanwhile: the next read returns it.
            backend.listed.push({ id: "r3", isDefault: false, revision: 0, url: "https://github.com/acme/docs.git" });
            await act(async () => {
                await vi.advanceTimersByTimeAsync(15_000);
            });

            expect(backend.listReads).toBe(2);
            expect(await screen.findByText("acme/docs")).toBeDefined();
        } finally {
            backend.listed.splice(1);
            vi.useRealTimers();
        }
    });

    it("keeps the list it has, with no error, when a refresh fails", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        try {
            backend.listReads = 0;
            renderSection();
            expect(await screen.findByText("acme/web")).toBeDefined();

            backend.listFails = true;
            await act(async () => {
                await vi.advanceTimersByTimeAsync(15_000);
            });

            expect(backend.listReads).toBe(2);
            expect(screen.getByText("acme/web")).toBeDefined();
            expect(screen.queryByText("Could not load this project's repositories.")).toBeNull();
        } finally {
            backend.listFails = false;
            vi.useRealTimers();
        }
    });
});
