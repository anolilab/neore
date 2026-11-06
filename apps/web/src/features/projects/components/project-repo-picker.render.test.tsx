import { fireEvent, render, screen } from "@testing-library/react";
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

const { projects } = vi.hoisted(() => {
    return {
        projects: [
            {
                _id: "p_web",
                repositories: [
                    { id: "repo_a", url: "https://github.com/acme/web.git" },
                    { defaultBranch: "develop", id: "repo_b", isDefault: true, url: "https://github.com/acme/api.git" },
                ],
                title: "Web",
            },
            { _id: "p_empty", title: "No code" },
        ],
    };
});

vi.mock("../hooks/use-projects", () => {
    return { useProjects: () => projects };
});

beforeEach(() => {
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

/** Opens the Select labelled `name` and returns its option texts. */
const optionsOf = async (name: string): Promise<string[]> => {
    fireEvent.click(screen.getByRole("combobox", { name }));

    const options = await screen.findAllByRole("option");

    return options.map((option) => option.textContent ?? "");
};

describe("ProjectRepoPicker", () => {
    it("offers only projects that list repositories", async () => {
        render(<ProjectRepoPicker onPick={vi.fn()} repoUrl="" />);

        expect(await optionsOf("Project")).toStrictEqual(["No project", "Web"]);
    });

    it("offers both repositories of a project with two, and shows the one the run uses", async () => {
        render(<ProjectRepoPicker onPick={vi.fn()} repoUrl="https://github.com/acme/web.git" />);

        expect(screen.getByRole("combobox", { name: "Project repository" }).textContent).toContain("acme/web");
        expect(await optionsOf("Project repository")).toStrictEqual(["acme/web", "acme/api"]);
    });

    it("preselects the project's default repository with its default branch", async () => {
        const onPick = vi.fn();

        render(<ProjectRepoPicker onPick={onPick} repoUrl="" />);
        await optionsOf("Project");
        fireEvent.keyDown(screen.getByRole("option", { name: "Web" }), { key: "Enter" });

        expect(onPick).toHaveBeenCalledWith({ defaultBranch: "develop", id: "repo_b", isDefault: true, url: "https://github.com/acme/api.git" });
    });

    it("renders nothing when no project lists a repository", () => {
        projects.shift();

        render(<ProjectRepoPicker onPick={vi.fn()} repoUrl="" />);

        expect(screen.queryByRole("combobox")).toBeNull();
    });
});
