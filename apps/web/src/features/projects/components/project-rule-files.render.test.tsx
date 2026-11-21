import { MAX_RULE_FILE_LENGTH } from "@neore/backend/rule-file-limits";
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

vi.mock("@lingui/core/macro", () => {
    return {
        plural: (count: number, forms: { one: string; other: string }) => (count === 1 ? forms.one : forms.other).split("#").join(String(count)),
    };
});

const backend = vi.hoisted(() => {
    return {
        listed: { canEdit: true, files: [] as unknown[], revision: "r1" } as { canEdit: boolean; files: unknown[]; legacyContextId?: string; revision: string },
        // When set, how a read answers instead of with `listed`.
        read: undefined as (() => Promise<unknown>) | undefined,
        // The project's repositories, and what the repository import's two actions answer.
        repoList: vi.fn(),
        repoRead: vi.fn(),
        repos: [] as { id: string; isDefault: boolean; revision: number; url: string }[],
        // When set, how the repositories' read answers instead of with `repos`.
        reposRead: undefined as (() => Promise<unknown>) | undefined,
        save: vi.fn(),
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useAction: (reference: { __lunoraRef?: string }) => (String(reference.__lunoraRef).endsWith("listRepoRuleFiles") ? backend.repoList : backend.repoRead),
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
                        listProjectRepos: {
                            queryOptions: (args: unknown) => {
                                return {
                                    queryFn: async () => await (backend.reposRead?.() ?? structuredClone(backend.repos)),
                                    queryKey: ["listProjectRepos", args],
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
const HUGE_FILE = /^rules\/huge\.md\s*\(too large\)$/u;
const LEFT_OUT_AS_TOO_LARGE = /1 file was left out as too large/u;
const COPY_OF_A = /^rules\/z\.md\s*\(same file as rules\/a\.md\)$/u;
const LINKED_COPY = /^CLAUDE\.md\s*\(same file as AGENTS\.md\)$/u;
const LINK_TO_Z = /^rules\/a\.md\s*\(same file as rules\/z\.md\)$/u;
const REFUSED_LINK = /^GEMINI\.md\s*\(links to a file outside the ones listed here\)$/u;
const WIDE_FILE = /^rules\/wide\.md\s*\(may be too long\)$/u;
const AT_ROOT_OF_API = /at the root of acme\/api/u;
const ONE_NOT_READ = /1 file was not read this time/u;

/** The client of the editor last rendered, to refresh what it read. */
const rendered = { queryClient: new QueryClient() };

const renderEditor = (onDirtyChange?: (dirty: boolean) => void, onSavingChange?: (saving: boolean) => void) => {
    rendered.queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    return render(
        <QueryClientProvider client={rendered.queryClient}>
            <ProjectRuleFiles onDirtyChange={onDirtyChange} onSavingChange={onSavingChange} projectId="p1" />
        </QueryClientProvider>,
    );
};

beforeEach(() => {
    translations.clear();
    backend.save.mockReset();
    backend.read = undefined;
    backend.repos = [];
    backend.reposRead = undefined;
    backend.repoList.mockReset();
    backend.repoRead.mockReset();
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

/** A picked file as the browser hands it, with its path inside a picked folder when it has one. */
const pickedFile = (name: string, text: string, folderPath?: string): File => {
    const file = new File([text], name, { type: "text/markdown" });

    if (folderPath) {
        Object.defineProperty(file, "webkitRelativePath", { value: folderPath });
    }

    return file;
};

describe("project rule files read when needed", () => {
    it("asks when to read a file read when needed, refuses it without, and saves its description", async () => {
        const user = userEvent.setup();

        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Add rule file" }));

        const added = screen.getByRole("listitem", { name: "Rule file 3" });

        await user.type(within(added).getByRole("textbox", { name: "Name" }), "Deploy");
        await user.click(within(added).getByRole("radio", { name: "When needed" }));
        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        expect(backend.save).not.toHaveBeenCalled();
        expect(screen.getByRole("alert").textContent).toBe("A file read when needed needs a line saying when to read it.");
        // eslint-disable-next-line testing-library/no-node-access -- where the focus lands is what this asserts
        expect(document.activeElement).toBe(within(added).getByRole("textbox", { name: "When to read it" }));

        await user.type(within(added).getByRole("textbox", { name: "When to read it" }), " How to deploy ");
        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        expect(backend.save.mock.calls[0]?.[0].ruleFiles[2]).toEqual({
            content: "",
            description: "How to deploy",
            id: expect.any(String),
            mode: "auto",
            title: "Deploy",
        });
    });
});

const LEFT_OUT = /left out/u;

/** A picked file whose text arrives only when `finish` is called: an import still reading. */
const slowFile = (name: string, text: string): { file: File; finish: () => void } => {
    const file = new File([text], name, { type: "text/markdown" });
    let finish = () => {};
    const ready = new Promise<string>((resolve) => {
        finish = () => resolve(text);
    });

    Object.defineProperty(file, "text", { value: async () => await ready });

    return { file, finish: () => finish() };
};

describe("importing rule files", () => {
    it("keeps the note of an import that added nothing when it lands during a save", async () => {
        const user = userEvent.setup();
        const saving: { finish: () => void } = { finish: () => {} };

        backend.save.mockImplementation(
            async ({ ruleFiles }: { ruleFiles: unknown[] }) =>
                await new Promise((resolve) => {
                    saving.finish = () => resolve({ files: ruleFiles, revision: "r2" });
                }),
        );
        renderEditor();
        await user.type(within(await screen.findByRole("listitem", { name: "SQL" })).getByRole("textbox", { name: "Instructions" }), " Always.");

        const slow = slowFile("huge.md", "x".repeat(MAX_RULE_FILE_LENGTH + 1));

        await user.upload(screen.getByTestId("rule-file-import"), slow.file);
        await user.click(screen.getByRole("button", { name: "Save rule files" }));
        slow.finish();
        await screen.findByText(LEFT_OUT_AS_TOO_LARGE);
        saving.finish();
        await screen.findByText("Rule files saved.");

        expect(screen.getByText(LEFT_OUT_AS_TOO_LARGE)).toBeTruthy();
    });

    it("applies an import that finishes after a save onto the list just saved, at its revision", async () => {
        const user = userEvent.setup();

        // The backend keeps what is saved, so the read after the save answers with it.
        backend.save.mockImplementation(async ({ ruleFiles }: { ruleFiles: unknown[] }) => {
            backend.listed = { ...backend.listed, files: ruleFiles, revision: "r2" };

            return { files: ruleFiles, revision: "r2" };
        });
        renderEditor();
        await user.type(within(await screen.findByRole("listitem", { name: "SQL" })).getByRole("textbox", { name: "Instructions" }), " Always.");

        const slow = slowFile("a.md", "---\ndescription: When A\n---\nA");

        await user.upload(screen.getByTestId("rule-file-import"), slow.file);
        await user.click(screen.getByRole("button", { name: "Save rule files" }));
        await screen.findByText("Rule files saved.");
        slow.finish();
        await screen.findByRole("listitem", { name: "a" });

        expect((within(screen.getByRole("listitem", { name: "SQL" })).getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe(
            "Use snake_case. Always.",
        );

        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        expect(backend.save.mock.calls[1]?.[0]).toMatchObject({ revision: "r2" });
        expect(backend.save.mock.calls[1]?.[0].ruleFiles.map((file: { title: string }) => file.title)).toStrictEqual(["Project context", "SQL", "a"]);
    });

    it("adds nothing from an import still reading when the changes are discarded", async () => {
        const user = userEvent.setup();

        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Add rule file" }));

        const slow = slowFile("a.md", "A");

        await user.upload(screen.getByTestId("rule-file-import"), slow.file);
        await user.click(screen.getByRole("button", { name: "Discard changes" }));
        slow.finish();
        await waitFor(() => expect(screen.getByRole("button", { name: "Import files" }).hasAttribute("disabled")).toBe(false));

        expect(screen.queryByRole("listitem", { name: "a" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Discard changes" })).toBeNull();
    });

    it("counts only the files it added when the last place was taken while it read, and takes one import at a time", async () => {
        const user = userEvent.setup();

        backend.listed.files = Array.from({ length: 19 }, (_, index) => {
            return { content: "x", id: `f${index}`, mode: "always", title: `F${index}` };
        });
        renderEditor();
        await screen.findByRole("listitem", { name: "F0" });

        const slow = slowFile("a.md", "A");

        await user.upload(screen.getByTestId("rule-file-import"), slow.file);

        expect(screen.getByRole("button", { name: "Import files" }).hasAttribute("disabled")).toBe(true);

        await user.click(screen.getByRole("button", { name: "Add rule file" }));
        slow.finish();

        await screen.findByText("1 file was left out. A project holds at most 20 rule files. Left out: a.md.");
        expect(screen.queryByRole("listitem", { name: "a" })).toBeNull();
    });

    it("takes a place freed while it read", async () => {
        const user = userEvent.setup();

        backend.listed.files = Array.from({ length: 20 }, (_, index) => {
            return { content: "x", id: `f${index}`, mode: "always", title: `F${index}` };
        });
        renderEditor();
        await screen.findByRole("listitem", { name: "F0" });

        const slow = slowFile("a.md", "A");

        await user.upload(screen.getByTestId("rule-file-import"), slow.file);
        await user.click(screen.getByRole("button", { name: "Delete F0" }));
        slow.finish();

        await screen.findByRole("listitem", { name: "a" });
        expect(screen.queryByText(LEFT_OUT)).toBeNull();
    });

    it("says which imported files need a description or another mode before they save", async () => {
        const user = userEvent.setup();

        renderEditor();
        await screen.findByRole("listitem", { name: "SQL" });
        await user.upload(screen.getByTestId("rule-folder-import"), [
            pickedFile("plain.md", "No front matter.", "rules/plain.md"),
            pickedFile("manual.md", "---\nalwaysApply: false # on request\n---\nOnly when asked.", "rules/manual.md"),
        ]);

        const manual = await screen.findByRole("listitem", { name: "manual" });

        expect(within(manual).getByRole("radio", { name: "When needed" }).getAttribute("aria-checked")).toBe("true");
        expect(
            screen.getByText("2 rule files imported. Review, then save. 2 files say nothing about when they apply: set a description or another mode."),
        ).toBeDefined();

        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        expect(backend.save).not.toHaveBeenCalled();
    });

    it("adds an uploaded AGENTS.md as one always file, an unsaved draft until saved", async () => {
        const user = userEvent.setup();
        const onDirtyChange = vi.fn();

        renderEditor(onDirtyChange);
        await screen.findByRole("listitem", { name: "SQL" });
        await user.upload(screen.getByTestId("rule-file-import"), pickedFile("AGENTS.md", "# Agents\n\nRun the tests."));

        const imported = await screen.findByRole("listitem", { name: "AGENTS.md" });

        expect(within(imported).getByRole("radio", { name: "Always" }).getAttribute("aria-checked")).toBe("true");
        expect((within(imported).getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe("# Agents\n\nRun the tests.");
        expect(screen.getByText("1 rule file imported. Review, then save.")).toBeDefined();
        expect(backend.save).not.toHaveBeenCalled();
        expect(onDirtyChange).toHaveBeenLastCalledWith(true);

        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        expect(backend.save.mock.calls[0]?.[0].ruleFiles).toHaveLength(3);
        expect(backend.save.mock.calls[0]?.[0].ruleFiles[2]).toEqual({
            content: "# Agents\n\nRun the tests.",
            id: expect.any(String),
            mode: "always",
            title: "AGENTS.md",
        });
    });

    it("imports a rule folder's Markdown files by their front matter, and leaves the rest out", async () => {
        const user = userEvent.setup();

        renderEditor();
        await screen.findByRole("listitem", { name: "SQL" });
        await user.upload(screen.getByTestId("rule-folder-import"), [
            pickedFile("deploy.md", "---\ndescription: How to deploy\n---\nRun the script.", "rules/deploy.md"),
            pickedFile("tests.md", "---\nglobs: src/**/*.test.ts\n---\nUse vitest.", "rules/tests.md"),
            pickedFile("logo.png", "png", "rules/logo.png"),
        ]);

        const deploy = await screen.findByRole("listitem", { name: "deploy" });
        const tests = screen.getByRole("listitem", { name: "tests" });

        expect((within(deploy).getByRole("textbox", { name: "When to read it" }) as HTMLInputElement).value).toBe("How to deploy");
        expect((within(deploy).getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe("Run the script.");
        expect((within(tests).getByRole("textbox", { name: "File patterns, one per line" }) as HTMLTextAreaElement).value).toBe("src/**/*.test.ts");
        expect(screen.getByText("2 rule files imported. Review, then save.")).toBeDefined();
    });

    it("imports no more files than the project has room for, and says how many it left out", async () => {
        const user = userEvent.setup();

        backend.listed.files = Array.from({ length: 19 }, (_, index) => {
            return { content: "x", id: `f${index}`, mode: "always", title: `F${index}` };
        });
        renderEditor();
        await screen.findByRole("listitem", { name: "F0" });
        await user.upload(screen.getByTestId("rule-file-import"), [pickedFile("a.md", "---\nalwaysApply: true\n---\nA"), pickedFile("b.md", "B")]);

        await screen.findByRole("listitem", { name: "a" });
        expect(screen.queryByRole("listitem", { name: "b" })).toBeNull();
        expect(
            screen.getByText("1 rule file imported. Review, then save. 1 file was left out. A project holds at most 20 rule files. Left out: b.md."),
        ).toBeDefined();
    });
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

    it("saves the rule files on Enter in a file's name or when to read it, never submitting the project form around it", async () => {
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

        // The saved list is read again; this backend answers with the one it was given.
        const sql = within(await screen.findByRole("listitem", { name: "SQL" }));

        await user.click(sql.getByRole("radio", { name: "When needed" }));
        await user.type(sql.getByRole("textbox", { name: "When to read it" }), "On schema changes{Enter}");

        await waitFor(() => expect(backend.save).toHaveBeenCalledTimes(2));
        expect(backend.save.mock.calls[1]?.[0]).toMatchObject({
            ruleFiles: [expect.anything(), expect.objectContaining({ description: "On schema changes", mode: "auto" })],
        });
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

    it("refuses a file renamed to open the id form before saving, on its name", async () => {
        const user = userEvent.setup();

        renderEditor();

        const name = within(await screen.findByRole("listitem", { name: "SQL" })).getByRole("textbox", { name: "Name" });

        await user.clear(name);
        await user.type(name, "Id: sql");
        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        expect(backend.save).not.toHaveBeenCalled();
        expect(screen.getByRole("alert").textContent).toContain('may not start with "id:"');
        expect(name.getAttribute("aria-invalid")).toBe("true");
    });

    it("saves a file already saved under a name opening the id form while another file is edited", async () => {
        const user = userEvent.setup();

        backend.listed = { ...backend.listed, files: [backend.listed.files[0], { ...(backend.listed.files[1] as Record<string, unknown>), title: "Id: sql" }] };
        renderEditor();

        await user.click(await screen.findByRole("button", { name: "Move Project context down" }));
        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        expect(backend.save.mock.calls[0]?.[0]).toMatchObject({ ruleFiles: [{ id: "sql", title: "Id: sql" }, { id: "context" }] });
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

describe("project rule files imported from the project's repository", () => {
    const REPO = { id: "repo1", isDefault: true, revision: 0, url: "https://github.com/acme/web.git" };
    const COMMIT = "c".repeat(40);

    it("offers nothing while the project lists no repository", async () => {
        renderEditor();
        await screen.findByRole("button", { name: "Add rule file" });

        expect(screen.queryByRole("button", { name: "Import from repository" })).toBeNull();
    });

    it("keeps keyboard focus on the search button while it looks and after the files are found", async () => {
        const user = userEvent.setup();
        const listing: { resolve: (value: unknown) => void } = { resolve: () => {} };

        backend.repos = [REPO];
        // The tsconfig lib and the configured Node range predate `Promise.withResolvers`.
        backend.repoList.mockReturnValue(
            new Promise((resolve) => {
                listing.resolve = resolve;
            }),
        );
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from repository" }));
        await user.click(screen.getByRole("button", { name: "Find files" }));

        // eslint-disable-next-line testing-library/no-node-access -- where the focus lands is what this asserts
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Looking..." }));
        // Said in the status region too: a changed button name alone is not reliably announced.
        expect(within(screen.getByTestId("repo-rule-file-import")).getByRole("status").textContent).toBe("Looking for instruction files...");

        listing.resolve({ commit: COMMIT, files: [{ path: "AGENTS.md", sha: "sha-agents", size: 20, tooLarge: false }], status: "ok", truncated: false });
        await screen.findByRole("list", { name: "Files found" });

        // eslint-disable-next-line testing-library/no-node-access -- where the focus lands is what this asserts
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Import selected" }));
    });

    it("reads nothing before the person asks, shows what was found, and imports an AGENTS.md as one always draft", async () => {
        const user = userEvent.setup();

        backend.repos = [REPO];
        backend.repoList.mockResolvedValue({
            commit: COMMIT,
            truncated: false,
            files: [
                { path: "AGENTS.md", sha: "sha-agents", size: 20, tooLarge: false },
                { path: "GEMINI.md", refused: "outside", size: 4, tooLarge: false },
                { path: "rules/huge.md", size: 900_000, tooLarge: true },
            ],
            status: "ok",
        });
        backend.repoRead.mockResolvedValue({ files: [{ path: "AGENTS.md", status: "ok", text: "Use pnpm, never npm." }], status: "ok" });
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from repository" }));

        expect(backend.repoList).not.toHaveBeenCalled();

        await user.click(screen.getByRole("button", { name: "Find files" }));

        expect(backend.repoList).toHaveBeenCalledWith({ projectId: "p1", repoId: "repo1" });

        const found = await screen.findByRole("list", { name: "Files found" });

        // Listing reads no file's text: only the click below does.
        expect(backend.repoRead).not.toHaveBeenCalled();
        expect(within(found).getByRole("checkbox", { name: "AGENTS.md" }).getAttribute("aria-checked")).toBe("true");
        expect(within(found).getByRole("checkbox", { name: HUGE_FILE }).getAttribute("aria-disabled")).toBe("true");
        // A symlink to a file that is not an instruction file: listed, never picked or read.
        expect(within(found).getByRole("checkbox", { name: REFUSED_LINK }).getAttribute("aria-disabled")).toBe("true");

        await user.click(screen.getByRole("button", { name: "Import selected" }));

        // With the blob its listing found, which the read takes.
        expect(backend.repoRead).toHaveBeenCalledWith({ commit: COMMIT, files: [{ path: "AGENTS.md", sha: "sha-agents" }], projectId: "p1", repoId: "repo1" });

        const imported = await screen.findByRole("listitem", { name: "AGENTS.md" });

        expect(within(imported).getByRole("radio", { name: "Always" }).getAttribute("aria-checked")).toBe("true");
        expect(within(imported).getByRole("textbox", { name: "Instructions" })).toHaveProperty("value", "Use pnpm, never npm.");
        expect(screen.getAllByRole("textbox", { name: "Name" })).toHaveLength(3);
        expect(backend.save).not.toHaveBeenCalled();
        expect(screen.getByText("1 rule file imported. Review, then save.")).toBeTruthy();
    });

    it("says why each link was not followed, and how many of the rules folder's files are not listed", async () => {
        const user = userEvent.setup();

        backend.repos = [REPO];
        backend.repoList.mockResolvedValue({
            commit: COMMIT,
            files: [
                { path: "rules/a.md", refused: "broken", size: 4, tooLarge: false },
                { path: "rules/b.md", refused: "budget", size: 4, tooLarge: false },
                { path: "rules/c.md", refused: "outside", size: 4, tooLarge: false },
                { path: "rules/d.md", refused: "too_deep", size: 4, tooLarge: false },
                { path: "rules/e.md", refused: "too_long", size: 2000, tooLarge: false },
            ],
            omitted: 7,
            status: "ok",
            truncated: false,
        });
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from repository" }));
        await user.click(screen.getByRole("button", { name: "Find files" }));

        const found = await screen.findByRole("list", { name: "Files found" });

        // A link not followed: listed with why, never picked or read.
        for (const name of [
            "rules/a.md (broken link: what it links to could not be found)",
            "rules/b.md (link not followed: this repository holds more links than one search follows)",
            "rules/c.md (links to a file outside the ones listed here)",
            "rules/d.md (links through too many other links)",
            "rules/e.md (link not followed: what it links to has too long a name)",
        ]) {
            const box = within(found).getByRole("checkbox", { name: (accessible) => accessible.replaceAll(/\s/gu, "") === name.replaceAll(" ", "") });

            expect(box.getAttribute("aria-disabled")).toBe("true");
        }

        expect(screen.getByText("The rules folder holds 7 more files than this list shows.")).toBeTruthy();
    });

    it("says why the repository could not be read and adds nothing", async () => {
        const user = userEvent.setup();

        backend.repos = [REPO];
        backend.repoList.mockResolvedValue({ status: "not_connected" });
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from repository" }));
        await user.click(screen.getByRole("button", { name: "Find files" }));

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe("Connect GitHub in Settings → Connectors to import from a repository.");
        expect(screen.getAllByRole("textbox", { name: "Name" })).toHaveLength(2);
    });

    it("adds nothing from a read the person cancelled, and gives focus back to the button that opens the panel", async () => {
        const user = userEvent.setup();

        backend.repos = [REPO];
        backend.repoList.mockResolvedValue({ commit: COMMIT, files: [{ path: "AGENTS.md", size: 20, tooLarge: false }], status: "ok", truncated: false });
        let settled = false;

        // Answers only once the panel is closed: the read lands after the Cancel.
        backend.repoRead.mockImplementation(async () => {
            try {
                await waitFor(() => expect(screen.queryByTestId("repo-rule-file-import")).toBeNull());

                return { files: [{ path: "AGENTS.md", status: "ok", text: "Use pnpm." }], status: "ok" };
            } finally {
                settled = true;
            }
        });
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from repository" }));
        await user.click(screen.getByRole("button", { name: "Find files" }));
        await user.click(await screen.findByRole("button", { name: "Import selected" }));
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        const opener = await screen.findByRole("button", { name: "Import from repository" });

        // eslint-disable-next-line testing-library/no-node-access -- where the focus lands is what this asserts
        await waitFor(() => expect(document.activeElement).toBe(opener));
        await waitFor(() => expect(settled).toBe(true));
        await waitFor(() => expect(opener.getAttribute("aria-disabled")).not.toBe("true"));
        expect(screen.queryByRole("listitem", { name: "AGENTS.md" })).toBeNull();
        expect(screen.getAllByRole("textbox", { name: "Name" })).toHaveLength(2);
    });

    it("says nothing of a read that fails after the person cancelled it", async () => {
        const user = userEvent.setup();

        backend.repos = [REPO];
        backend.repoList.mockResolvedValue({ commit: COMMIT, files: [{ path: "AGENTS.md", size: 20, tooLarge: false }], status: "ok", truncated: false });
        let settled = false;

        backend.repoRead.mockImplementation(async () => {
            try {
                await waitFor(() => expect(screen.queryByTestId("repo-rule-file-import")).toBeNull());

                throw new Error("network");
            } finally {
                settled = true;
            }
        });
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from repository" }));
        await user.click(screen.getByRole("button", { name: "Find files" }));
        await user.click(await screen.findByRole("button", { name: "Import selected" }));
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        const opener = await screen.findByRole("button", { name: "Import from repository" });

        await waitFor(() => expect(settled).toBe(true));
        await waitFor(() => expect(opener.getAttribute("aria-disabled")).not.toBe("true"));
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.queryByText("The files could not be read.")).toBeNull();
    });

    it("says when the project's repositories could not be loaded, and loads them on a retry", async () => {
        const user = userEvent.setup();

        backend.repos = [REPO];
        backend.reposRead = async () => {
            throw new Error("network");
        };
        renderEditor();

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe("The project's repositories could not be loaded, so importing from one is not available.");

        backend.reposRead = undefined;
        await user.click(screen.getByRole("button", { name: "Try again" }));

        expect(await screen.findByRole("button", { name: "Import from repository" })).toBeTruthy();
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("shows a search's failure only for the repository it searched", async () => {
        const user = userEvent.setup();
        const listing: { resolve: (value: unknown) => void } = { resolve: () => {} };

        backend.repos = [REPO];
        backend.repoList.mockReturnValue(
            new Promise((resolve) => {
                listing.resolve = resolve;
            }),
        );
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from repository" }));
        await user.click(screen.getByRole("button", { name: "Find files" }));

        // A refresh replaces the repository while the search runs.
        backend.repos = [{ id: "repo2", isDefault: true, revision: 0, url: "https://github.com/acme/api.git" }];
        await rendered.queryClient.invalidateQueries({ queryKey: ["listProjectRepos"] });
        await screen.findByText(AT_ROOT_OF_API);
        listing.resolve({ status: "not_found" });

        await waitFor(() => expect(screen.getByRole("button", { name: "Find files" }).getAttribute("aria-disabled")).not.toBe("true"));
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("clears an earlier read's failure when the person tries again", async () => {
        const user = userEvent.setup();

        backend.repos = [REPO];
        backend.repoList.mockResolvedValue({
            commit: COMMIT,
            files: ["a", "b"].map((name) => {
                return { path: `rules/${name}.md`, sha: `sha-${name}`, size: 10, tooLarge: false };
            }),
            status: "ok",
            truncated: false,
        });
        backend.repoRead.mockResolvedValueOnce({ status: "rate_limited" });
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from repository" }));
        await user.click(screen.getByRole("button", { name: "Find files" }));
        await user.click(await screen.findByRole("button", { name: "Import selected" }));

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe("GitHub is limiting requests. Try again in a few minutes.");

        backend.repoRead.mockResolvedValueOnce({
            files: [
                { path: "rules/a.md", status: "ok", text: "---\nalwaysApply: true\n---\nText" },
                { path: "rules/b.md", status: "not_read" },
            ],
            status: "ok",
        });
        await user.click(screen.getByRole("button", { name: "Import selected" }));

        expect(await screen.findByText(ONE_NOT_READ)).toBeTruthy();
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("leaves the panel as it is when the person discards their changes while a read runs", async () => {
        const user = userEvent.setup();
        const reading: { resolve: (value: unknown) => void } = { resolve: () => {} };

        backend.repos = [REPO];
        backend.repoList.mockResolvedValue({
            commit: COMMIT,
            files: [{ path: "AGENTS.md", sha: "sha-agents", size: 20, tooLarge: false }],
            status: "ok",
            truncated: false,
        });
        backend.repoRead.mockReturnValue(
            new Promise((resolve) => {
                reading.resolve = resolve;
            }),
        );
        renderEditor();
        const names = await screen.findAllByRole("textbox", { name: "Name" });

        await user.type(names[0]!, " edited");
        await user.click(screen.getByRole("button", { name: "Import from repository" }));
        await user.click(screen.getByRole("button", { name: "Find files" }));
        await user.click(await screen.findByRole("button", { name: "Import selected" }));
        await user.click(screen.getByRole("button", { name: "Discard changes" }));
        reading.resolve({ status: "rate_limited" });

        await waitFor(() => expect(screen.getByRole("button", { name: "Import selected" }).getAttribute("aria-disabled")).not.toBe("true"));
        expect(screen.queryByRole("alert")).toBeNull();
        expect(
            within(screen.getByRole("list", { name: "Files found" }))
                .getByRole("checkbox", { name: "AGENTS.md" })
                .getAttribute("aria-checked"),
        ).toBe("true");
    });

    it("keeps nothing ticked when the person unticked what a read left unread", async () => {
        const user = userEvent.setup();
        const reading: { resolve: (value: unknown) => void } = { resolve: () => {} };

        backend.repos = [REPO];
        backend.repoList.mockResolvedValue({
            commit: COMMIT,
            files: ["a", "b"].map((name) => {
                return { path: `rules/${name}.md`, sha: `sha-${name}`, size: 10, tooLarge: false };
            }),
            status: "ok",
            truncated: false,
        });
        backend.repoRead.mockReturnValue(
            new Promise((resolve) => {
                reading.resolve = resolve;
            }),
        );
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from repository" }));
        await user.click(screen.getByRole("button", { name: "Find files" }));
        await user.click(await screen.findByRole("button", { name: "Import selected" }));

        const found = screen.getByRole("list", { name: "Files found" });

        await user.click(within(found).getByRole("checkbox", { name: "rules/b.md" }));
        reading.resolve({
            files: [
                { path: "rules/a.md", status: "ok", text: "---\nalwaysApply: true\n---\nText" },
                { path: "rules/b.md", status: "not_read" },
            ],
            status: "ok",
        });

        expect(await screen.findByText("1 rule file imported. Review, then save.")).toBeTruthy();
        expect(within(found).getByRole("checkbox", { name: "rules/a.md" }).getAttribute("aria-checked")).toBe("false");
        expect(within(found).getByRole("checkbox", { name: "rules/b.md" }).getAttribute("aria-checked")).toBe("false");
    });

    it("reads the first files a project holds of a larger selection and names the first few left out", async () => {
        const user = userEvent.setup();
        const paths = Array.from({ length: 27 }, (_, index) => `rules/r${String(index).padStart(2, "0")}.md`);

        backend.repos = [REPO];
        backend.listed = { canEdit: true, files: [], revision: "r1" };
        backend.repoList.mockResolvedValue({
            commit: COMMIT,
            truncated: false,
            files: paths.toReversed().map((path) => {
                return { path, size: 10, tooLarge: false };
            }),
            status: "ok",
        });
        backend.repoRead.mockImplementation(async ({ files: asked }: { files: { path: string }[] }) => {
            return {
                files: asked.map(({ path }) => {
                    return { path, status: "ok", text: "---\nalwaysApply: true\n---\nText" };
                }),
                status: "ok",
            };
        });
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from repository" }));
        await user.click(screen.getByRole("button", { name: "Find files" }));
        await user.click(await screen.findByRole("button", { name: "Import selected" }));

        expect(backend.repoRead).toHaveBeenCalledWith({
            commit: COMMIT,
            files: paths.slice(0, 20).map((path) => {
                return { path };
            }),
            projectId: "p1",
            repoId: "repo1",
        });
        expect(
            await screen.findByText(
                "20 rule files imported. Review, then save. 7 files were left out. A project holds at most 20 rule files. Left out: rules/r20.md, rules/r21.md, rules/r22.md, rules/r23.md, rules/r24.md, and 2 more.",
            ),
        ).toBeTruthy();
    });

    it("offers a file whose bytes may hold too many characters unticked, and leaves out files a save would refuse as too large", async () => {
        const user = userEvent.setup();
        const paths = Array.from({ length: 13 }, (_, index) => `rules/r${String(index).padStart(2, "0")}.md`);
        const text = (path: string) => (path === "rules/r00.md" ? "a".repeat(100_001) : `${path} ${"b".repeat(90_000)}`);

        backend.repos = [REPO];
        backend.repoList.mockResolvedValue({
            commit: COMMIT,
            truncated: false,
            files: [
                ...paths.map((path) => {
                    return { path, size: 10, tooLarge: false };
                }),
                { path: "rules/wide.md", size: 300_000, tooLarge: false },
            ],
            status: "ok",
        });
        backend.repoRead.mockImplementation(async ({ files: asked }: { files: { path: string }[] }) => {
            return {
                files: asked.map(({ path }) => {
                    return { path, status: "ok", text: `---\nalwaysApply: true\n---\n${text(path)}` };
                }),
                status: "ok",
            };
        });
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from repository" }));
        await user.click(screen.getByRole("button", { name: "Find files" }));

        const found = await screen.findByRole("list", { name: "Files found" });

        expect(within(found).getByRole("checkbox", { name: WIDE_FILE }).getAttribute("aria-checked")).toBe("false");

        await user.click(screen.getByRole("button", { name: "Import selected" }));

        expect(backend.repoRead).toHaveBeenCalledWith({
            commit: COMMIT,
            files: paths.map((path) => {
                return { path };
            }),
            projectId: "p1",
            repoId: "repo1",
        });
        // Eleven of 90 KB fit beside the two saved files; the one past a file's length and the twelfth, past 1 MB, do not.
        expect(
            await screen.findByText(
                "11 rule files imported. Review, then save. 2 files were left out as too large: a rule file holds at most 100,000 characters, and all of a project's together at most 1 MB. Too large: rules/r00.md and rules/r12.md.",
            ),
        ).toBeTruthy();
        expect(screen.getAllByRole("textbox", { name: "Name" })).toHaveLength(13);
    });

    it("reads at the commit it listed, from the repository it listed, and says when GitHub could not list everything", async () => {
        const user = userEvent.setup();
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const other = { id: "repo2", isDefault: false, revision: 0, url: "https://github.com/acme/api.git" };

        backend.repos = [REPO, other];
        backend.repoList.mockResolvedValue({ commit: COMMIT, files: [{ path: "AGENTS.md", size: 20, tooLarge: false }], status: "ok", truncated: true });
        backend.repoRead.mockResolvedValue({ files: [{ path: "AGENTS.md", status: "ok", text: "Use pnpm." }], status: "ok" });
        render(
            <QueryClientProvider client={client}>
                <ProjectRuleFiles projectId="p1" />
            </QueryClientProvider>,
        );
        await user.click(await screen.findByRole("button", { name: "Import from repository" }));
        await user.click(screen.getByRole("button", { name: "Find files" }));

        expect(await screen.findByText("This repository is too large for GitHub to list in full, so some instruction files may be missing here.")).toBeTruthy();

        // A refresh that makes the other repository the one shown drops the listing: its paths are not read there.
        backend.repos = [{ ...other, isDefault: true }];
        await client.invalidateQueries({ queryKey: ["listProjectRepos"] });

        await waitFor(() => expect(screen.queryByRole("list", { name: "Files found" })).toBeNull());
        expect(screen.getByRole("button", { name: "Find files" })).toBeTruthy();

        // Back as the one shown, its listing is its own again: the same repository, read at the same commit.
        backend.repos = [REPO, other];
        await client.invalidateQueries({ queryKey: ["listProjectRepos"] });
        await user.click(await screen.findByRole("button", { name: "Import selected" }));

        expect(backend.repoRead).toHaveBeenCalledWith({ commit: COMMIT, files: [{ path: "AGENTS.md" }], projectId: "p1", repoId: "repo1" });
    });

    it("adds what a read could take and says how many files it had no requests left for, to import again", async () => {
        const user = userEvent.setup();

        backend.repos = [REPO];
        backend.repoList.mockResolvedValue({
            commit: COMMIT,
            files: [
                { path: "rules/a.md", sha: "sha-a", size: 10, tooLarge: false },
                { path: "rules/b.md", sha: "sha-b", size: 10, tooLarge: false },
                { path: "rules/c.md", sha: "sha-c", size: 10, tooLarge: false },
            ],
            status: "ok",
            truncated: false,
        });
        backend.repoRead.mockResolvedValue({
            files: [
                { path: "rules/a.md", status: "ok", text: "---\nalwaysApply: true\n---\nText" },
                { path: "rules/b.md", status: "not_read" },
                { path: "rules/c.md", status: "not_read" },
            ],
            status: "ok",
        });
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from repository" }));
        await user.click(screen.getByRole("button", { name: "Find files" }));
        await user.click(await screen.findByRole("button", { name: "Import selected" }));

        expect(await screen.findByText("1 rule file imported. Review, then save. 2 files were not read this time: import again to add the rest.")).toBeTruthy();

        // The panel stays open with only those ticked: importing again adds nothing twice.
        const found = screen.getByRole("list", { name: "Files found" });

        expect(within(found).getByRole("checkbox", { name: "rules/a.md" }).getAttribute("aria-checked")).toBe("false");
        expect(within(found).getByRole("checkbox", { name: "rules/b.md" }).getAttribute("aria-checked")).toBe("true");

        backend.repoRead.mockResolvedValue({
            files: ["rules/b.md", "rules/c.md"].map((path) => {
                return { path, status: "ok", text: "---\nalwaysApply: true\n---\nText" };
            }),
            status: "ok",
        });
        await user.click(screen.getByRole("button", { name: "Import selected" }));

        expect(backend.repoRead).toHaveBeenLastCalledWith({
            commit: COMMIT,
            files: [
                { path: "rules/b.md", sha: "sha-b" },
                { path: "rules/c.md", sha: "sha-c" },
            ],
            projectId: "p1",
            repoId: "repo1",
        });
        await waitFor(() => expect(screen.queryByTestId("repo-rule-file-import")).toBeNull());
        expect(screen.getAllByRole("textbox", { name: "Name" })).toHaveLength(5);
    });

    it("keeps the picks the person changed while a read ran, less what it answered and any copy of it", async () => {
        const user = userEvent.setup();
        let answer: ((value: unknown) => void) | undefined;

        backend.repos = [REPO];
        backend.repoList.mockResolvedValue({
            commit: COMMIT,
            files: [
                ...["a", "b", "c"].map((name) => {
                    return { path: `rules/${name}.md`, sha: `sha-${name}`, size: 10, tooLarge: false };
                }),
                // A link to rules/a.md: its blob.
                { linkOf: "rules/a.md", path: "rules/z.md", sha: "sha-a", size: 10, tooLarge: false },
            ],
            status: "ok",
            truncated: false,
        });
        backend.repoRead.mockImplementation(
            async () =>
                // The configured Node range predates `Promise.withResolvers`.
                // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
                await new Promise((resolve) => {
                    answer = resolve;
                }),
        );
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from repository" }));
        await user.click(screen.getByRole("button", { name: "Find files" }));
        await user.click(await screen.findByRole("button", { name: "Import selected" }));

        const found = screen.getByRole("list", { name: "Files found" });

        await user.click(within(found).getByRole("checkbox", { name: "rules/c.md" }));
        await user.click(within(found).getByRole("checkbox", { name: COPY_OF_A }));
        answer?.({
            files: [
                { path: "rules/a.md", status: "ok", text: "---\nalwaysApply: true\n---\nText" },
                { path: "rules/b.md", status: "not_read" },
                { path: "rules/c.md", status: "not_read" },
            ],
            status: "ok",
        });

        // Only rules/b.md is still ticked of the two not read.
        expect(await screen.findByText("1 rule file imported. Review, then save. 1 file was not read this time: import again to add the rest.")).toBeTruthy();
        expect(within(found).getByRole("checkbox", { name: "rules/a.md" }).getAttribute("aria-checked")).toBe("false");
        expect(within(found).getByRole("checkbox", { name: "rules/b.md" }).getAttribute("aria-checked")).toBe("true");
        expect(within(found).getByRole("checkbox", { name: "rules/c.md" }).getAttribute("aria-checked")).toBe("false");
        expect(within(found).getByRole("checkbox", { name: COPY_OF_A }).getAttribute("aria-checked")).toBe("false");
    });

    it("reads a rules-folder link to a root file as two files, one always and one by its front matter", async () => {
        const user = userEvent.setup();
        const text = "---\nglobs: src/**/*.ts\n---\nUse pnpm.";

        backend.repos = [REPO];
        backend.listed = { canEdit: true, files: [], revision: "r1" };
        backend.repoList.mockResolvedValue({
            commit: COMMIT,
            files: [
                { path: "AGENTS.md", sha: "sha-shared", size: 40, tooLarge: false },
                // A link to the root file: still read by its front matter, so another draft.
                { linkOf: "AGENTS.md", path: "rules/AGENTS.md", sha: "sha-shared", size: 40, tooLarge: false },
            ],
            status: "ok",
            truncated: false,
        });
        backend.repoRead.mockImplementation(async ({ files: asked }: { files: { path: string }[] }) => {
            return {
                files: asked.map(({ path }) => {
                    return { path, status: "ok", text };
                }),
                status: "ok",
            };
        });
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from repository" }));
        await user.click(screen.getByRole("button", { name: "Find files" }));

        const found = await screen.findByRole("list", { name: "Files found" });

        expect(within(found).getByRole("checkbox", { name: "rules/AGENTS.md" }).getAttribute("aria-checked")).toBe("true");

        await user.click(screen.getByRole("button", { name: "Import selected" }));

        expect(backend.repoRead).toHaveBeenCalledWith({
            commit: COMMIT,
            files: [
                { path: "AGENTS.md", sha: "sha-shared" },
                { path: "rules/AGENTS.md", sha: "sha-shared" },
            ],
            projectId: "p1",
            repoId: "repo1",
        });
        expect(await screen.findByText("2 rule files imported. Review, then save.")).toBeTruthy();
        expect((within(screen.getByRole("listitem", { name: "AGENTS.md" })).getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe(
            text,
        );
        expect(
            (within(screen.getByRole("listitem", { name: "AGENTS" })).getByRole("textbox", { name: "File patterns, one per line" }) as HTMLTextAreaElement)
                .value,
        ).toBe("src/**/*.ts");
    });

    it("reads two files with the same bytes under different names as two rule files", async () => {
        const user = userEvent.setup();

        backend.repos = [REPO];
        backend.listed = { canEdit: true, files: [], revision: "r1" };
        backend.repoList.mockResolvedValue({
            commit: COMMIT,
            files: [
                // Copies, not links: the same blob, two files.
                { path: "rules/a.md", sha: "sha-same", size: 10, tooLarge: false },
                { path: "rules/b.md", sha: "sha-same", size: 10, tooLarge: false },
            ],
            status: "ok",
            truncated: false,
        });
        backend.repoRead.mockImplementation(async ({ files: asked }: { files: { path: string }[] }) => {
            return {
                files: asked.map(({ path }) => {
                    return { path, status: "ok", text: "---\nalwaysApply: true\n---\nUse pnpm." };
                }),
                status: "ok",
            };
        });
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from repository" }));
        await user.click(screen.getByRole("button", { name: "Find files" }));

        const found = await screen.findByRole("list", { name: "Files found" });

        expect(within(found).getByRole("checkbox", { name: "rules/a.md" }).getAttribute("aria-checked")).toBe("true");
        expect(within(found).getByRole("checkbox", { name: "rules/b.md" }).getAttribute("aria-checked")).toBe("true");

        await user.click(screen.getByRole("button", { name: "Import selected" }));

        expect(backend.repoRead).toHaveBeenCalledWith({
            commit: COMMIT,
            files: [
                { path: "rules/a.md", sha: "sha-same" },
                { path: "rules/b.md", sha: "sha-same" },
            ],
            projectId: "p1",
            repoId: "repo1",
        });
        expect(await screen.findByText("2 rule files imported. Review, then save.")).toBeTruthy();
        expect(screen.getByRole("listitem", { name: "a" })).toBeTruthy();
        expect(screen.getByRole("listitem", { name: "b" })).toBeTruthy();
    });

    it("reads a link sorted before the file it leads to as that file, once when both are picked", async () => {
        const user = userEvent.setup();

        backend.repos = [REPO];
        backend.listed = { canEdit: true, files: [], revision: "r1" };
        backend.repoList.mockResolvedValue({
            commit: COMMIT,
            files: [
                // A link to rules/z.md, listed first.
                { linkOf: "rules/z.md", path: "rules/a.md", sha: "sha-z", size: 10, tooLarge: false },
                { path: "rules/z.md", sha: "sha-z", size: 10, tooLarge: false },
            ],
            status: "ok",
            truncated: false,
        });
        backend.repoRead.mockImplementation(async ({ files: asked }: { files: { path: string }[] }) => {
            return {
                files: asked.map(({ path }) => {
                    return { path, status: "ok", text: "---\nalwaysApply: true\n---\nUse pnpm." };
                }),
                status: "ok",
            };
        });
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from repository" }));
        await user.click(screen.getByRole("button", { name: "Find files" }));

        const found = await screen.findByRole("list", { name: "Files found" });

        const link = within(found).getByRole("checkbox", { name: LINK_TO_Z });

        expect(link.getAttribute("aria-checked")).toBe("false");

        await user.click(link);
        await user.click(screen.getByRole("button", { name: "Import selected" }));

        // Both picked: the link is left out for the file it leads to.
        expect(backend.repoRead).toHaveBeenCalledWith({ commit: COMMIT, files: [{ path: "rules/z.md", sha: "sha-z" }], projectId: "p1", repoId: "repo1" });
        expect(
            await screen.findByText(
                "1 rule file imported. Review, then save. 1 file was left out as the same file as another picked: the same text would apply twice.",
            ),
        ).toBeTruthy();
    });

    it("names the files the read refused", async () => {
        const user = userEvent.setup();

        backend.repos = [REPO];
        backend.listed = { canEdit: true, files: [], revision: "r1" };
        backend.repoList.mockResolvedValue({
            commit: COMMIT,
            files: ["AGENTS.md", "rules/big.md", "rules/gone.md", "rules/link.md"].map((path) => {
                return { path, size: 10, tooLarge: false };
            }),
            status: "ok",
            truncated: false,
        });
        backend.repoRead.mockResolvedValue({
            files: [
                { path: "AGENTS.md", status: "ok", text: "Use pnpm." },
                { path: "rules/big.md", status: "too_large" },
                { path: "rules/gone.md", status: "missing" },
                { path: "rules/link.md", status: "refused" },
            ],
            status: "ok",
        });
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from repository" }));
        await user.click(screen.getByRole("button", { name: "Find files" }));
        await user.click(await screen.findByRole("button", { name: "Import selected" }));

        expect(
            await screen.findByText(
                "1 rule file imported. Review, then save. 3 files could not be read: gone from the repository or too large. Not read: rules/big.md, rules/gone.md, and rules/link.md.",
            ),
        ).toBeTruthy();
    });

    it("ticks a link to another listed file off, says which, and reads one file of the same blob however both are picked", async () => {
        const user = userEvent.setup();

        backend.repos = [REPO];
        backend.repoList.mockResolvedValue({
            commit: COMMIT,
            files: [
                { path: "AGENTS.md", sha: "sha-agents", size: 20, tooLarge: false },
                { linkOf: "AGENTS.md", path: "CLAUDE.md", sha: "sha-agents", size: 20, tooLarge: false },
            ],
            status: "ok",
            truncated: false,
        });
        backend.repoRead.mockResolvedValue({ files: [{ path: "AGENTS.md", status: "ok", text: "Use pnpm." }], status: "ok" });
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from repository" }));
        await user.click(screen.getByRole("button", { name: "Find files" }));

        const link = within(await screen.findByRole("list", { name: "Files found" })).getByRole("checkbox", {
            name: LINKED_COPY,
        });

        expect(link.getAttribute("aria-checked")).toBe("false");

        await user.click(link);
        await user.click(screen.getByRole("button", { name: "Import selected" }));

        expect(backend.repoRead).toHaveBeenCalledWith({ commit: COMMIT, files: [{ path: "AGENTS.md", sha: "sha-agents" }], projectId: "p1", repoId: "repo1" });
        expect(
            await screen.findByText(
                "1 rule file imported. Review, then save. 1 file was left out as the same file as another picked: the same text would apply twice.",
            ),
        ).toBeTruthy();
    });

    it("shortens a file name past what a save takes, keeping two that start alike apart, renames one opening the id form, and the drafts save", async () => {
        const user = userEvent.setup();
        const long = "n".repeat(250);
        // And one opening the id form, which a save refuses for a new name.
        const paths = [`rules/${long}a.md`, `rules/${long}b.md`, "rules/id:setup.md"];

        backend.repos = [REPO];
        backend.repoList.mockResolvedValue({
            commit: COMMIT,
            files: paths.map((path) => {
                return { path, size: 10, tooLarge: false };
            }),
            status: "ok",
            truncated: false,
        });
        backend.repoRead.mockResolvedValue({
            files: paths.map((path) => {
                return { path, status: "ok", text: "---\nalwaysApply: true\n---\nText" };
            }),
            status: "ok",
        });
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from repository" }));
        await user.click(screen.getByRole("button", { name: "Find files" }));
        await user.click(await screen.findByRole("button", { name: "Import selected" }));

        expect(
            await screen.findByText(
                "3 rule files imported. Review, then save. 2 names were shortened to 200 characters. 1 name opened with id:, which names a file by its id, so it now opens with id- instead.",
            ),
        ).toBeTruthy();

        const names = screen.getAllByRole("textbox", { name: "Name" }).map((input) => (input as HTMLInputElement).value);

        expect(names.slice(2)).toStrictEqual(["id-setup", "n".repeat(200), `${"n".repeat(196)} (2)`]);

        await user.click(screen.getByRole("button", { name: "Save rule files" }));

        await waitFor(() => expect(backend.save).toHaveBeenCalledTimes(1));
    });

    it("keeps an import that lands while a save runs as unsaved drafts on top of the saved list, and says so", async () => {
        const user = userEvent.setup();
        let finishSave: (() => void) | undefined;

        backend.repos = [REPO];
        backend.save.mockImplementation(async ({ ruleFiles }: { ruleFiles: unknown[] }) => {
            // The configured Node range predates `Promise.withResolvers`.
            // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
            await new Promise<void>((resolve) => {
                finishSave = resolve;
            });

            return { files: ruleFiles, revision: "r2" };
        });
        backend.repoList.mockResolvedValue({ commit: COMMIT, files: [{ path: "AGENTS.md", size: 20, tooLarge: false }], status: "ok", truncated: false });
        backend.repoRead.mockResolvedValue({ files: [{ path: "AGENTS.md", status: "ok", text: "Use pnpm." }], status: "ok" });
        renderEditor();

        const [first] = await screen.findAllByRole("textbox", { name: "Name" });

        await user.type(first!, " edited");
        await user.click(screen.getByRole("button", { name: "Save rule files" }));
        await waitFor(() => expect(finishSave).toBeDefined());
        await user.click(screen.getByRole("button", { name: "Import from repository" }));
        await user.click(screen.getByRole("button", { name: "Find files" }));
        await user.click(await screen.findByRole("button", { name: "Import selected" }));
        await screen.findByRole("listitem", { name: "AGENTS.md" });
        finishSave!();

        await waitFor(() => expect(screen.getByRole("button", { name: "Save rule files" })).toHaveProperty("disabled", false));
        expect(screen.queryByText("Rule files saved.")).toBeNull();
        expect(screen.getByText("1 rule file imported. Review, then save.")).toBeTruthy();
        expect(screen.getAllByRole("textbox", { name: "Name" }).map((input) => (input as HTMLInputElement).value)).toStrictEqual([
            "Project context edited",
            "SQL",
            "AGENTS.md",
        ]);

        // The next save sends the import on top of the list just saved, from that list's revision.
        await user.click(screen.getByRole("button", { name: "Save rule files" }));
        await waitFor(() => expect(backend.save).toHaveBeenCalledTimes(2));
        finishSave!();

        expect(backend.save.mock.calls[1]![0]).toMatchObject({ revision: "r2" });
    });
});
