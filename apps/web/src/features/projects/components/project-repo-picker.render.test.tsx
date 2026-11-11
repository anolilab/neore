import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ProjectRepoPicker from "./project-repo-picker";

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

// `gate.open` holds every repository-list answer back until it resolves.
const { gate, repositories } = vi.hoisted(() => {
    return {
        gate: { open: Promise.resolve() },
        repositories: [
            { id: "repo_a", isDefault: false, url: "https://github.com/acme/web.git" },
            { defaultBranch: "develop", id: "repo_b", isDefault: true, url: "https://github.com/acme/api.git" },
        ],
    };
});

vi.mock("@/lib/lunora/crpc", async () => {
    const { skipToken: skip } = await import("@tanstack/react-query");

    return {
        useCRPC: () => {
            return {
                projects: {
                    functions: {
                        findRepoProject: {
                            queryOptions: (args: unknown) =>
                                args === skip
                                    ? { queryFn: skip, queryKey: ["find"] }
                                    : {
                                          queryFn: async () => {
                                              return { projectId: "p_far", title: "Far" };
                                          },
                                          queryKey: ["find", args],
                                      },
                        },
                        listProjectRepos: {
                            queryOptions: (args: unknown) =>
                                args === skip
                                    ? { queryFn: skip, queryKey: ["repos"] }
                                    : {
                                          queryFn: async () => {
                                              await gate.open;

                                              return repositories;
                                          },
                                          queryKey: ["repos", args],
                                      },
                        },
                    },
                },
            };
        },
    };
});

beforeEach(() => {
    gate.open = Promise.resolve();
    // The popup positions itself with these; jsdom lacks getAnimations, and the setup's observer mock (re-installed before every test) is not constructible.
    Element.prototype.getAnimations = () => [];
    vi.stubGlobal(
        "ResizeObserver",
        class {
            disconnect = vi.fn();

            observe = vi.fn();

            unobserve = vi.fn();
        },
    );
});

describe("ProjectRepoPicker", () => {
    it("preselects the picked project's default repository with its default branch", async () => {
        const onPick = vi.fn();

        render(
            <QueryClientProvider client={new QueryClient()}>
                <ProjectRepoPicker branch="" onPick={onPick} projects={[{ _id: "p_web", title: "Web" }]} repoUrl="" />
            </QueryClientProvider>,
        );

        fireEvent.click(screen.getByRole("combobox", { name: "Project" }));
        fireEvent.keyDown(await screen.findByRole("option", { name: "Web" }), { key: "Enter" });

        await waitFor(() => expect(onPick).toHaveBeenCalledWith(repositories[1]));
    });

    it("never preselects into a form that no longer shows the picker", async () => {
        let release: () => void = () => undefined;

        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        gate.open = new Promise<void>((resolve) => {
            release = resolve;
        });

        const onPick = vi.fn();
        const { unmount } = render(
            <QueryClientProvider client={new QueryClient()}>
                <ProjectRepoPicker branch="" onPick={onPick} projects={[{ _id: "p_web", title: "Web" }]} repoUrl="" />
            </QueryClientProvider>,
        );

        fireEvent.click(screen.getByRole("combobox", { name: "Project" }));
        fireEvent.keyDown(await screen.findByRole("option", { name: "Web" }), { key: "Enter" });
        // The run's assignee changes before the project's repositories arrive: the picker is gone.
        unmount();
        release();
        await gate.open;
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(onPick).not.toHaveBeenCalled();
    });

    it("reopened on a saved run, shows the project that lists its repository, typed in short form", async () => {
        render(
            <QueryClientProvider client={new QueryClient()}>
                <ProjectRepoPicker branch="" onPick={vi.fn()} projects={[{ _id: "p_web", title: "Web" }]} repoUrl="acme/api" />
            </QueryClientProvider>,
        );

        const project = await screen.findByRole("combobox", { name: "Project" });

        expect(project.textContent).toContain("No project");
        await waitFor(() => expect(screen.getByRole("combobox", { name: "Project" }).textContent).toContain("Far"));
        await waitFor(() => expect(screen.getByRole("combobox", { name: "Project repository" }).textContent).toContain("acme/api"));
    });
});
