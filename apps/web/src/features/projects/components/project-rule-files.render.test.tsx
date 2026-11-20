import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FormEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const NEEDS_A_PATTERN = /needs at least one pattern/u;

const renderEditor = (onDirtyChange?: (dirty: boolean) => void, onSavingChange?: (saving: boolean) => void) =>
    render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <ProjectRuleFiles onDirtyChange={onDirtyChange} onSavingChange={onSavingChange} projectId="p1" />
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

afterEach(() => {
    onlineManager.setOnline(true);
});

describe("project rule files", () => {
    it("tells a screen reader a file's name and, for a pattern file, its patterns are required", async () => {
        renderEditor();

        const sql = within(await screen.findByRole("listitem", { name: "SQL" }));

        expect(sql.getByRole("textbox", { name: "Name" }).getAttribute("aria-required")).toBe("true");
        expect(sql.getByRole("textbox", { name: "File patterns, one per line" }).getAttribute("aria-required")).toBe("true");
        expect(sql.getByRole("textbox", { name: "Instructions" }).hasAttribute("aria-required")).toBe(false);
    });

    it("hands a save made offline to the client at once, which queues it, instead of pausing it", async () => {
        const user = userEvent.setup();

        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Move SQL up" }));
        onlineManager.setOnline(false);
        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        await waitFor(() => expect(backend.save).toHaveBeenCalledOnce());
    });

    it("reorders, deletes and adds a pattern file, then saves the whole list in its new order", async () => {
        const user = userEvent.setup();

        renderEditor();

        await user.click(await screen.findByRole("button", { name: "Move SQL up" }));
        await user.click(screen.getByRole("button", { name: "Delete Project context" }));
        await user.click(screen.getByRole("button", { name: "Add rule file" }));

        const added = screen.getByRole("listitem", { name: "Rule file 2" });

        await user.type(within(added).getByRole("textbox", { name: "Name" }), "Docs");
        await user.click(within(added).getByRole("radio", { name: "When files match" }));
        await user.type(within(added).getByRole("textbox", { name: "File patterns, one per line" }), "docs/**{enter}*.md");
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

    it("moves focus after a Delete to the file in its place, else the one before, else Add rule file", async () => {
        const user = userEvent.setup();

        backend.listed = {
            ...backend.listed,
            files: ["A", "B", "C"].map((title) => {
                return { content: "", id: title, mode: "always", title };
            }),
        };
        renderEditor();

        await user.click(await screen.findByRole("button", { name: "Delete B" }));
        // eslint-disable-next-line testing-library/no-node-access -- where the focus lands is what this asserts
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete C" }));
        await user.keyboard("{Enter}");
        // eslint-disable-next-line testing-library/no-node-access -- where the focus lands is what this asserts
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete A" }));
        await user.keyboard("{Enter}");
        // eslint-disable-next-line testing-library/no-node-access -- where the focus lands is what this asserts
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add rule file" }));
    });

    it("saves the rule files on Enter in a file's name, never submitting the project form around it", async () => {
        const user = userEvent.setup();
        const submitProject = vi.fn((event: FormEvent) => event.preventDefault());

        // As in the project dialog: a submit button makes Enter in a field submit the form.
        render(
            <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
                <form onSubmit={submitProject}>
                    <ProjectRuleFiles projectId="p1" />
                    <button type="submit">Save project</button>
                </form>
            </QueryClientProvider>,
        );

        const name = within(await screen.findByRole("listitem", { name: "SQL" })).getByRole("textbox", { name: "Name" });

        // Unchanged: nothing to save, and still no project submit.
        await user.type(name, "{Enter}");

        expect(backend.save).not.toHaveBeenCalled();

        await user.type(name, " rules{Enter}");

        await waitFor(() => expect(backend.save).toHaveBeenCalledOnce());
        expect(backend.save.mock.calls[0]?.[0]).toMatchObject({ ruleFiles: [expect.anything(), expect.objectContaining({ title: "SQL rules" })] });
        expect(submitProject).not.toHaveBeenCalled();
    });

    it("keeps Enter in a file's patterns and instructions for a new line, without saving", async () => {
        const user = userEvent.setup();

        renderEditor();

        const sql = within(await screen.findByRole("listitem", { name: "SQL" }));

        await user.type(sql.getByRole("textbox", { name: "File patterns, one per line" }), "{Enter}*.psql");
        await user.type(sql.getByRole("textbox", { name: "Instructions" }), "{Enter}Quote names.");

        expect(backend.save).not.toHaveBeenCalled();
        expect((sql.getByRole("textbox", { name: "File patterns, one per line" }) as HTMLTextAreaElement).value).toBe("**/*.sql\n*.psql");
        expect((sql.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe("Use snake_case.\nQuote names.");
    });

    it("refuses to save a pattern file without a pattern, and says why", async () => {
        const user = userEvent.setup();

        renderEditor();

        await user.click(await screen.findByRole("button", { name: "Add rule file" }));
        await user.type(within(screen.getByRole("listitem", { name: "Rule file 3" })).getByRole("textbox", { name: "Name" }), "Empty");
        await user.click(within(screen.getByRole("listitem", { name: "Empty" })).getByRole("radio", { name: "When files match" }));
        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        expect(backend.save).not.toHaveBeenCalled();
        expect(screen.getByRole("alert").textContent).toContain("needs at least one pattern");

        // The field it names says so to a screen reader, is described by the error and takes the focus.
        const patterns = within(screen.getByRole("listitem", { name: "Empty" })).getByRole("textbox", {
            description: NEEDS_A_PATTERN,
            name: "File patterns, one per line",
        });

        expect(patterns.getAttribute("aria-invalid")).toBe("true");
        // eslint-disable-next-line testing-library/no-node-access -- where the focus lands is what this asserts
        expect(document.activeElement).toBe(patterns);
        expect(
            within(screen.getByRole("listitem", { name: "SQL" }))
                .getByRole("textbox", { name: "File patterns, one per line" })
                .hasAttribute("aria-invalid"),
        ).toBe(false);
    });

    it("marks and focuses the first unnamed file's name, again on each refused save", async () => {
        const user = userEvent.setup();

        renderEditor();

        await user.click(await screen.findByRole("button", { name: "Add rule file" }));
        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        const name = within(screen.getByRole("listitem", { name: "Rule file 3" })).getByRole("textbox", {
            description: "Give every rule file a name.",
            name: "Name",
        });

        expect(name.getAttribute("aria-invalid")).toBe("true");
        // eslint-disable-next-line testing-library/no-node-access -- where the focus lands is what this asserts
        expect(document.activeElement).toBe(name);

        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        // eslint-disable-next-line testing-library/no-node-access -- where the focus lands is what this asserts
        expect(document.activeElement).toBe(name);
    });

    it.each([
        ["a name past its length", { title: "t".repeat(201) }, "Name", "may be at most 200 characters"],
        [
            "more patterns than a file holds",
            { globs: Array.from({ length: 11 }, (_, index) => `${index}.sql`) },
            "File patterns, one per line",
            "more than 10 file patterns",
        ],
        ["a pattern past its length", { globs: ["p".repeat(201)] }, "File patterns, one per line", "at most 200 characters on one line"],
        ["a pattern with a NUL", { globs: ["a\0b.sql"] }, "File patterns, one per line", "at most 200 characters on one line"],
    ])("refuses %s before saving, on the field it names", async (_, change, field, message) => {
        const user = userEvent.setup();

        backend.listed = { ...backend.listed, files: [backend.listed.files[0], { ...(backend.listed.files[1] as Record<string, unknown>), ...change }] };
        renderEditor();

        await user.click(await screen.findByRole("button", { name: "Move Project context down" }));
        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        expect(backend.save).not.toHaveBeenCalled();
        expect(screen.getByRole("alert").textContent).toContain(message);

        const [first] = screen.getAllByRole("listitem");
        const input = within(first as HTMLElement).getByRole("textbox", { name: field });

        expect(input.getAttribute("aria-invalid")).toBe("true");
        expect(input.getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id);
        // eslint-disable-next-line testing-library/no-node-access -- where the focus lands is what this asserts
        expect(document.activeElement).toBe(input);
    });

    it("refuses a list larger than it may be stored before saving, measured as stored, naming the whole list", async () => {
        const user = userEvent.setup();

        // 600,000 characters, but twice that once stored: each backslash is written escaped.
        backend.listed = {
            ...backend.listed,
            files: Array.from({ length: 6 }, (_, index) => {
                return { content: "\\".repeat(99_999), id: `f${index}`, mode: "always", title: `F${index}` };
            }),
        };
        renderEditor();

        await user.click(await screen.findByRole("button", { name: "Move F0 down" }));
        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        expect(backend.save).not.toHaveBeenCalled();
        expect(screen.getByRole("alert").textContent).toContain("larger than 1 MB");
        expect(screen.queryAllByRole("textbox").some((input) => input.hasAttribute("aria-invalid"))).toBe(false);
        expect(screen.getByRole("button", { name: "Save rule files" }).getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id);
    });

    it("words and places a limit the backend refused as its own check would", async () => {
        const user = userEvent.setup();

        backend.save.mockRejectedValue(
            Object.assign(new Error("A rule file's name must be 1 to 200 characters"), {
                code: "BAD_REQUEST",
                data: { code: "RULE_FILE_TITLE_TOO_LONG", fileId: "sql" },
            }),
        );
        renderEditor();

        await user.click(await screen.findByRole("button", { name: "Move SQL up" }));
        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        const name = within(screen.getByRole("listitem", { name: "SQL" })).getByRole("textbox", { name: "Name" });

        await waitFor(() => expect(name.getAttribute("aria-invalid")).toBe("true"));
        expect(screen.getByRole("alert").textContent).toBe("A rule file's name may be at most 200 characters.");
        // eslint-disable-next-line testing-library/no-node-access -- where the focus lands is what this asserts
        expect(document.activeElement).toBe(name);
    });

    it("words a list the backend refused as too large, and a refusal naming a file no longer shown as any other", async () => {
        const user = userEvent.setup();

        backend.save.mockRejectedValueOnce(Object.assign(new Error("too large"), { code: "BAD_REQUEST", data: { code: "RULE_FILES_TOO_LARGE" } }));
        backend.save.mockRejectedValueOnce(
            Object.assign(new Error("A rule file holds at most 100000 characters"), {
                code: "BAD_REQUEST",
                data: { code: "RULE_FILE_CONTENT_TOO_LONG", fileId: "gone" },
            }),
        );
        renderEditor();

        await user.click(await screen.findByRole("button", { name: "Move SQL up" }));
        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("larger than 1 MB"));

        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("A rule file holds at most 100000 characters"));
        expect(screen.queryAllByRole("textbox").some((input) => input.hasAttribute("aria-invalid"))).toBe(false);
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

        await user.type(within(await screen.findByRole("listitem", { name: "SQL" })).getByRole("textbox", { name: "Name" }), "!");
        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        expect(backend.save.mock.calls[0]?.[0]).toMatchObject({ keepContext: true, ruleFiles: [{ id: "sql", title: "SQL!" }] });
    });

    it("counts a kept older context toward the rule files a project holds", async () => {
        const user = userEvent.setup();

        backend.listed = {
            ...backend.listed,
            files: [
                { content: "x".repeat(100_001), id: "context", mode: "always", title: "Project context" },
                ...Array.from({ length: 20 }, (_, index) => {
                    return { content: "y", id: `f${index}`, mode: "always", title: `F${index}` };
                }),
            ],
            legacyContextId: "context",
        };
        renderEditor();

        await user.click(await screen.findByRole("button", { name: "Move F0 down" }));
        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        expect(backend.save).not.toHaveBeenCalled();
        expect(screen.getByRole("alert").textContent).toContain("at most 20 rule files");
    });

    it("keeps an unchanged long older context first and kept while the files after it are reordered", async () => {
        const user = userEvent.setup();

        backend.listed = {
            ...backend.listed,
            files: [
                { content: "x".repeat(100_001), id: "context", mode: "always", title: "Project context" },
                backend.listed.files[1],
                { content: "Docs.", id: "docs", mode: "always", title: "Docs" },
            ],
            legacyContextId: "context",
        };
        renderEditor();

        // Nothing moves above the kept context, nor the context itself: the backend keeps it first.
        const sqlUp = await screen.findByRole("button", { name: "Move SQL up" });

        expect(sqlUp.hasAttribute("disabled")).toBe(true);
        expect(screen.getByRole("button", { name: "Move Project context down" }).hasAttribute("disabled")).toBe(true);

        await user.click(screen.getByRole("button", { name: "Move Docs up" }));
        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        expect(screen.queryByRole("alert")).toBeNull();
        expect(backend.save.mock.calls[0]?.[0]).toMatchObject({ keepContext: true, ruleFiles: [{ id: "docs" }, { id: "sql" }] });
    });

    it("holds an older context longer than a rule file to the limits once it was changed", async () => {
        const user = userEvent.setup();

        backend.listed = {
            ...backend.listed,
            files: [{ content: "x".repeat(100_001), id: "context", mode: "always", title: "Project context" }, backend.listed.files[1]],
            legacyContextId: "context",
        };
        renderEditor();

        await user.type(within(await screen.findByRole("listitem", { name: "Project context" })).getByLabelText("Instructions"), "!");
        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        expect(backend.save).not.toHaveBeenCalled();
        expect(screen.getByRole("alert").textContent).toContain("is longer than");
        // eslint-disable-next-line testing-library/no-node-access -- where the focus lands is what this asserts
        expect(document.activeElement).toBe(within(screen.getByRole("listitem", { name: "Project context" })).getByLabelText("Instructions"));
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

    it("says beside Save why the project save was refused, focuses Save, and drops the notice once discarded", async () => {
        const user = userEvent.setup();
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const editor = (blockedSaveRequest: number) => (
            <QueryClientProvider client={client}>
                <ProjectRuleFiles blockedSaveRequest={blockedSaveRequest} projectId="p1" />
            </QueryClientProvider>
        );
        const { rerender } = render(editor(0));

        await user.click(await screen.findByRole("button", { name: "Move SQL up" }));
        expect(screen.queryByRole("alert")).toBeNull();

        rerender(editor(1));

        const notice = await screen.findByText("Save or discard your rule file changes first.");
        const save = screen.getByRole("button", { name: "Save rule files" });

        // Read once, as Save's description where focus lands, not announced a second time as an alert.
        expect(screen.queryByRole("alert")).toBeNull();
        expect(save.getAttribute("aria-describedby")).toBe(notice.id);
        // eslint-disable-next-line testing-library/no-node-access -- where the focus lands is what this asserts
        await waitFor(() => expect(document.activeElement).toBe(save));

        // Each refused project save moves focus back to Save.
        await user.click(screen.getByRole("button", { name: "Add rule file" }));
        rerender(editor(2));
        // eslint-disable-next-line testing-library/no-node-access -- where the focus lands is what this asserts
        await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save rule files" })));

        await user.click(screen.getByRole("button", { name: "Discard changes" }));
        expect(screen.queryByText("Save or discard your rule file changes first.")).toBeNull();

        // A new draft starts without the old notice.
        await user.click(await screen.findByRole("button", { name: "Move SQL up" }));
        expect(screen.queryByText("Save or discard your rule file changes first.")).toBeNull();
        expect(screen.getByRole("button", { name: "Save rule files" }).hasAttribute("aria-describedby")).toBe(false);
    });

    it("takes no refusal made before it was mounted as its own: no notice, focus left where it is", async () => {
        const user = userEvent.setup();

        render(
            <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
                <ProjectRuleFiles blockedSaveRequest={3} projectId="p1" />
            </QueryClientProvider>,
        );

        await user.click(await screen.findByRole("button", { name: "Move SQL up" }));

        expect(screen.queryByText("Save or discard your rule file changes first.")).toBeNull();
        // eslint-disable-next-line testing-library/no-node-access -- where the focus lands is what this asserts
        expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Save rule files" }));
    });

    it("offers no discard while a save is on its way, and tells the dialog it is saving", async () => {
        const user = userEvent.setup();
        const onSavingChange = vi.fn();

        // A save that takes a while to answer, as one over a slow connection does.
        backend.save.mockImplementation(async () => {
            await new Promise((resolve) => {
                setTimeout(resolve, 300);
            });

            return { files: [{ content: "Old notes", id: "context", mode: "always", title: "Project context" }], revision: "r2" };
        });
        renderEditor(undefined, onSavingChange);

        await user.click(await screen.findByRole("button", { name: "Delete SQL" }));
        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        await waitFor(() => {
            expect((screen.getByRole("button", { name: "Discard changes" }) as HTMLButtonElement).disabled).toBe(true);
        });
        expect(onSavingChange).toHaveBeenLastCalledWith(true);

        expect(await screen.findByText("Rule files saved.")).toBeTruthy();
        expect(onSavingChange).toHaveBeenLastCalledWith(false);
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
