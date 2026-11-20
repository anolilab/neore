import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ProjectRuleFiles from "./project-rule-files";

// What `t` translates, by source text; empty: every message stays English.
const translations = vi.hoisted(() => new Map<string, string>());

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                i18n: { _: (descriptor: { id: string }) => descriptor.id, locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => {
                    const text = String.raw({ raw: strings }, ...values);

                    return translations.get(text) ?? text;
                },
            };
        },
    };
});

const backend = vi.hoisted(() => {
    return {
        listed: { canEdit: true, files: [] as unknown[], revision: "r1" } as { canEdit: boolean; files: unknown[]; legacyContextId?: string; revision: string },
        // When set, how a read answers instead of with `listed`.
        read: undefined as (() => Promise<unknown>) | undefined,
        save: vi.fn(),
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                projects: {
                    functions: {
                        listProjectRuleFiles: {
                            queryOptions: (args: unknown) => {
                                return {
                                    queryFn: async () => await (backend.read?.() ?? structuredClone(backend.listed)),
                                    queryKey: ["listProjectRuleFiles", args],
                                };
                            },
                        },
                        setProjectRuleFiles: {
                            mutationOptions: () => {
                                return { mutationFn: backend.save };
                            },
                        },
                    },
                },
            };
        },
    };
});

vi.mock("@/features/auth/lib/utilities", () => {
    return { getLocalizedError: ({ error }: { error: Error }) => error.message };
});

const renderEditor = (onDirtyChange?: (dirty: boolean) => void) =>
    render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <ProjectRuleFiles onDirtyChange={onDirtyChange} projectId="p1" />
        </QueryClientProvider>,
    );

beforeEach(() => {
    translations.clear();
    backend.save.mockReset();
    backend.read = undefined;
    backend.save.mockImplementation(async ({ ruleFiles }: { ruleFiles: unknown[] }) => {
        return { files: ruleFiles, revision: "r2" };
    });
    backend.listed = {
        canEdit: true,
        revision: "r1",
        files: [
            { content: "Old notes", id: "context", mode: "always", title: "Project context" },
            { content: "Use snake_case.", globs: ["**/*.sql"], id: "sql", mode: "glob", title: "SQL" },
        ],
    };
});

describe("project rule files", () => {
    it("reorders, deletes and adds a pattern file, then saves the whole list in its new order", async () => {
        const user = userEvent.setup();

        renderEditor();

        await user.click(await screen.findByRole("button", { name: "Move SQL up" }));
        await user.click(screen.getByRole("button", { name: "Delete Project context" }));
        await user.click(screen.getByRole("button", { name: "Add rule file" }));

        const added = screen.getByRole("listitem", { name: "Rule file 2" });

        await user.type(within(added).getByLabelText("Name"), "Docs");
        await user.click(within(added).getByRole("radio", { name: "When files match" }));
        await user.type(within(added).getByLabelText("File patterns, one per line"), "docs/**{enter}*.md");
        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        expect(backend.save).toHaveBeenCalledOnce();
        expect(backend.save.mock.calls[0]?.[0]).toEqual({
            projectId: "p1",
            revision: "r1",
            ruleFiles: [
                { content: "Use snake_case.", globs: ["**/*.sql"], id: "sql", mode: "glob", title: "SQL" },
                { content: "", globs: ["docs/**", "*.md"], id: expect.any(String), mode: "glob", title: "Docs" },
            ],
        });
    });

    it("refuses to save a pattern file without a pattern, and says why", async () => {
        const user = userEvent.setup();

        renderEditor();

        await user.click(await screen.findByRole("button", { name: "Add rule file" }));
        await user.type(within(screen.getByRole("listitem", { name: "Rule file 3" })).getByLabelText("Name"), "Empty");
        await user.click(within(screen.getByRole("listitem", { name: "Empty" })).getByRole("radio", { name: "When files match" }));
        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        expect(backend.save).not.toHaveBeenCalled();
        expect(screen.getByRole("alert").textContent).toContain("needs at least one pattern");
    });

    it("keeps the draft and says what to do when the files were saved elsewhere meanwhile", async () => {
        const user = userEvent.setup();

        backend.save.mockRejectedValue(Object.assign(new Error("changed"), { code: "CONFLICT" }));
        renderEditor();

        await user.click(await screen.findByRole("button", { name: "Delete SQL" }));
        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        expect(screen.getByRole("alert").textContent).toContain("changed meanwhile");
        expect(screen.queryByRole("listitem", { name: "SQL" })).toBeNull();
        expect(screen.getByRole("button", { name: "Discard changes" })).toBeTruthy();
    });

    it("shows the saved list after discarding a draft a save elsewhere made stale", async () => {
        const user = userEvent.setup();

        backend.save.mockRejectedValue(Object.assign(new Error("changed"), { code: "CONFLICT" }));
        renderEditor();

        await user.click(await screen.findByRole("button", { name: "Delete SQL" }));
        backend.listed = { ...backend.listed, files: [{ content: "New", id: "new", mode: "always", title: "Saved elsewhere" }], revision: "r2" };
        await user.click(screen.getByRole("button", { name: "Save rule files" }));
        await user.click(screen.getByRole("button", { name: "Discard changes" }));

        expect(await screen.findByRole("listitem", { name: "Saved elsewhere" })).toBeTruthy();
    });

    it("keeps edits typed while a save runs, based on the list just saved", async () => {
        const user = userEvent.setup();
        const resolvers: ((value: { files: unknown[]; revision: string }) => void)[] = [];

        backend.save.mockImplementationOnce(
            async () =>
                await new Promise<{ files: unknown[]; revision: string }>((resolve) => {
                    resolvers.push(resolve);
                }),
        );
        renderEditor();

        await user.click(await screen.findByRole("button", { name: "Delete Project context" }));
        await user.click(screen.getByRole("button", { name: "Save rule files" }));
        await user.type(within(screen.getByRole("listitem", { name: "SQL" })).getByLabelText("Instructions"), " Always.");
        backend.listed = { ...backend.listed, files: [backend.listed.files[1]], revision: "r2" };
        resolvers[0]?.({ files: [backend.listed.files[0]], revision: "r2" });

        await screen.findByRole("button", { name: "Save rule files" });
        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        expect(backend.save.mock.calls[1]?.[0]).toMatchObject({ revision: "r2", ruleFiles: [{ content: "Use snake_case. Always.", id: "sql" }] });
    });

    it("saves the older context under the backend's own name, not the one shown in the person's language", async () => {
        const user = userEvent.setup();

        translations.set("Project context", "Projektkontext");
        renderEditor();

        await user.click(await screen.findByRole("button", { name: "Move SQL up" }));
        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        expect(screen.getByRole("listitem", { name: "Projektkontext" })).toBeTruthy();
        expect(backend.save.mock.calls[0]?.[0]).toMatchObject({ ruleFiles: [{ id: "sql" }, { id: "context", title: "Project context" }] });
    });

    it("shows the list just saved at once, before the list is read again", async () => {
        const user = userEvent.setup();

        renderEditor();

        await user.click(await screen.findByRole("button", { name: "Delete SQL" }));
        // A read that never answers: what shows is what the save itself put there.
        backend.read = async () =>
            await new Promise(() => {
                // Never settles.
            });
        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        expect(await screen.findByText("Rule files saved.")).toBeTruthy();
        expect(screen.queryByRole("listitem", { name: "SQL" })).toBeNull();
        expect(screen.getByRole("listitem", { name: "Project context" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Save rule files" })).toBeNull();
    });

    it("leaves an unchanged older context longer than a rule file where it is, and saves the rest", async () => {
        const user = userEvent.setup();

        backend.listed = {
            ...backend.listed,
            files: [{ content: "x".repeat(100_001), id: "context", mode: "always", title: "Project context" }, backend.listed.files[1]],
            legacyContextId: "context",
        };
        renderEditor();

        await user.type(within(await screen.findByRole("listitem", { name: "SQL" })).getByLabelText("Name"), "!");
        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        expect(backend.save.mock.calls[0]?.[0]).toMatchObject({ keepContext: true, ruleFiles: [{ id: "sql", title: "SQL!" }] });
    });

    it("holds an older context longer than a rule file to the limits once it was changed", async () => {
        const user = userEvent.setup();

        backend.listed = {
            ...backend.listed,
            files: [{ content: "x".repeat(100_001), id: "context", mode: "always", title: "Project context" }, backend.listed.files[1]],
            legacyContextId: "context",
        };
        renderEditor();

        await user.click(await screen.findByRole("button", { name: "Move SQL up" }));
        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        expect(backend.save).not.toHaveBeenCalled();
        expect(screen.getByRole("alert").textContent).toContain("is longer than");
    });

    it("tells the dialog while unsaved changes are open", async () => {
        const user = userEvent.setup();
        const onDirtyChange = vi.fn();

        renderEditor(onDirtyChange);

        await user.click(await screen.findByRole("button", { name: "Delete SQL" }));
        expect(onDirtyChange).toHaveBeenLastCalledWith(true);
        await user.click(screen.getByRole("button", { name: "Discard changes" }));
        expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    });

    it("shows a member who may not edit the files what they say, without any control to change them", async () => {
        backend.listed = { ...backend.listed, canEdit: false };
        renderEditor();

        expect(await screen.findByText("SQL")).toBeTruthy();
        expect(screen.getByText("Use snake_case.")).toBeTruthy();
        expect(screen.getByText("**/*.sql")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Add rule file" })).toBeNull();
        expect(screen.queryByRole("textbox")).toBeNull();
    });
});
