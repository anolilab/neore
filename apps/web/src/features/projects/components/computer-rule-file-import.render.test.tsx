import { onlineManager, QueryClient, QueryClientProvider, skipToken } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ProjectRuleFiles from "./project-rule-files";

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

vi.mock("@lingui/core/macro", () => {
    return {
        plural: (count: number, forms: { one: string; other: string }) => (count === 1 ? forms.one : forms.other).split("#").join(String(count)),
    };
});

vi.mock("@/features/auth/lib/utilities", () => {
    return { getLocalizedError: ({ error }: { error: Error }) => error.message };
});

type Row = { code?: string; error?: string; files?: unknown[]; phase?: string; status: string };

const backend = vi.hoisted(() => {
    return {
        calls: new Map<string, Row>(),
        devices: [] as Record<string, unknown>[],
        // Calls whose status cannot be read, as a query failing after its retries.
        lost: new Set<string>(),
        // Queries answered once, not again every few milliseconds.
        unpolled: new Set<string>(),
        // Live queries whose subscription went quiet: each refetch answers from its first push, as Lunora's does;
        // only a read with `{ live: false }` reaches the backend.
        quiet: new Set<string>(),
        pushed: new Map<string, unknown>(),
        ruleFiles: [] as Record<string, unknown>[],
        listDevices: vi.fn(),
        // The options each start was built with: online-only, never paused or retried.
        startOptions: [] as unknown[][],
        start: vi.fn(),
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    // Answered again every few milliseconds, as a live query is pushed every change.
    const polled = (key: string, read: (args: never) => unknown) => {
        const answer = (args: unknown, live: boolean) => {
            const fresh = structuredClone(read(args as never)) ?? null;
            const pushKey = JSON.stringify([key, args]);

            if (!live || !backend.quiet.has(key)) {
                return fresh;
            }

            if (!backend.pushed.has(pushKey)) {
                backend.pushed.set(pushKey, fresh);
            }

            return structuredClone(backend.pushed.get(pushKey));
        };

        return {
            queryOptions: (args: unknown, options?: { live?: boolean }) =>
                args === skipToken
                    ? { queryFn: skipToken, queryKey: [key] }
                    : {
                          queryFn: async () => answer(args, options?.live !== false),
                          queryKey: [key, args],
                          refetchInterval: backend.unpolled.has(key) ? false : 10,
                      },
        };
    };

    return {
        // The repository import beside it, never opened here.
        useAction: () => vi.fn(),
        useCRPC: () => {
            return {
                devices: {
                    functions: { listDevices: polled("listDevices", () => backend.listDevices()) },
                    global_instructions: {
                        getGlobalInstructionsCall: polled("getGlobalInstructionsCall", ({ callId }: { callId: string }) => {
                            if (backend.lost.has(callId)) {
                                throw new Error("lost");
                            }

                            return backend.calls.get(callId);
                        }),
                        startGlobalInstructionsCall: {
                            mutationOptions: (...options: unknown[]) => {
                                backend.startOptions.push(options);

                                return { mutationFn: backend.start };
                            },
                        },
                    },
                },
                projects: {
                    functions: {
                        listProjectRuleFiles: {
                            queryOptions: (args: unknown) => {
                                return {
                                    queryFn: async () => {
                                        return { canEdit: true, files: backend.ruleFiles, revision: "r1" };
                                    },
                                    queryKey: ["listProjectRuleFiles", args],
                                };
                            },
                        },
                        listProjectRepos: {
                            queryOptions: (args: unknown) => {
                                return { queryFn: async () => [], queryKey: ["listProjectRepos", args] };
                            },
                        },
                        setProjectRuleFiles: {
                            mutationOptions: () => {
                                return { mutationFn: vi.fn() };
                            },
                        },
                    },
                },
            };
        },
    };
});

const LOOKS_FOR = /Looks for the global CLAUDE\.md/u;

const LISTED = [
    { id: "claude", name: "CLAUDE.md", path: "~/.claude/CLAUDE.md", size: 2048, status: "found" },
    { id: "codex", name: "AGENTS.md", path: "~/.codex/AGENTS.md", size: 10, status: "found" },
    { id: "gemini", name: "GEMINI.md", path: "~/.gemini/GEMINI.md", status: "missing" },
    { id: "windsurf", name: "global_rules.md", path: "~/.codeium/windsurf/memories/global_rules.md", size: 90_000, status: "too_large" },
];

const isDisabled = (element: HTMLElement): boolean => element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";

const openAndList = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole("button", { name: "Import from this computer" }));
    await user.click(await screen.findByRole("button", { name: "Find files" }));
    await screen.findByRole("list", { name: "Instruction files" });
};

const renderEditor = () =>
    render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <ProjectRuleFiles projectId="p1" />
        </QueryClientProvider>,
    );

const ruleFiles = (count: number) =>
    Array.from({ length: count }, (_, index) => {
        return { content: `Rule ${String(index)}`, id: `saved-${String(index)}`, mode: "always", title: `Saved ${String(index)}` };
    });

/** The read's answer: each file asked for, as read with its text. */
const readAll = (files: string[], listed = LISTED): Row => {
    return {
        files: listed
            .filter((file) => files.includes(file.id))
            .map((file) => {
                return { ...file, status: "read", text: `${file.name} text` };
            }),
        status: "completed",
    };
};

afterEach(() => {
    vi.useRealTimers();
    onlineManager.setOnline(true);
});

beforeEach(() => {
    backend.calls.clear();
    backend.lost.clear();
    backend.unpolled.clear();
    backend.quiet.clear();
    backend.pushed.clear();
    backend.ruleFiles = [];
    backend.devices = [
        { _id: "desk", createdAt: 0, lastSeenAt: Date.now(), name: "Studio", platform: "linux", toolNames: [], updateRequired: false },
        // A server reached over SSH is never offered.
        {
            _id: "srv",
            createdAt: 0,
            lastSeenAt: Date.now(),
            name: "Build box",
            platform: "linux",
            toolNames: [],
            transport: "ssh",
            updateRequired: false,
            viaDeviceId: "desk",
        },
    ];
    backend.listDevices.mockReset();
    backend.listDevices.mockImplementation(() => backend.devices);
    backend.start.mockReset();
    // Each call is answered by the device a moment later: approved, then done.
    backend.start.mockImplementation(async ({ files }: { files?: string[] }) => {
        const callId = `call-${String(backend.start.mock.calls.length)}`;

        backend.calls.set(callId, { phase: "prompting", status: "claimed" });
        setTimeout(() => {
            backend.calls.set(callId, files ? readAll(files) : { files: LISTED, status: "completed" });
        }, 50);

        return { callId };
    });
});

describe("import from this computer", () => {
    it("asks the computer for nothing until the person clicks, not even which devices there are", async () => {
        const user = userEvent.setup();

        renderEditor();

        const trigger = await screen.findByRole("button", { name: "Import from this computer" });

        expect(backend.listDevices).not.toHaveBeenCalled();
        await user.click(trigger);

        expect(backend.start).not.toHaveBeenCalled();
        expect(await screen.findByText(LOOKS_FOR)).toBeDefined();
        expect(backend.listDevices).toHaveBeenCalled();
        expect(backend.start).not.toHaveBeenCalled();
    });

    it("lists the files, reads only those ticked and adds them as unsaved drafts through the upload's parser", async () => {
        const user = userEvent.setup();

        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from this computer" }));
        await user.click(await screen.findByRole("button", { name: "Find files" }));

        expect(backend.start).toHaveBeenLastCalledWith({ deviceId: "desk" }, expect.anything());
        expect(await screen.findByText("Approve the request in the desktop app on Studio.")).toBeDefined();

        const list = await screen.findByRole("list", { name: "Instruction files" });
        const boxes = within(list).getAllByRole("checkbox");

        expect(boxes.map((box) => box.getAttribute("aria-checked"))).toEqual(["true", "true", "false", "false"]);
        expect(boxes[2]?.hasAttribute("data-disabled")).toBe(true);
        expect(within(list).getByText("(too large)")).toBeDefined();
        expect(within(list).getByText("2 KB")).toBeDefined();

        await user.click(boxes[1]!);
        await user.click(screen.getByRole("button", { name: "Import selected" }));

        expect(backend.start).toHaveBeenLastCalledWith({ deviceId: "desk", files: ["claude"] }, expect.anything());

        const imported = await screen.findByRole("listitem", { name: "CLAUDE.md" });

        expect(within(imported).getByRole("radio", { name: "Always" }).getAttribute("aria-checked")).toBe("true");
        expect((within(imported).getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe("CLAUDE.md text");
        expect(screen.getByText("1 rule file imported. Review, then save.")).toBeDefined();
        expect(screen.queryByRole("listitem", { name: "AGENTS.md" })).toBeNull();
        await waitFor(() => expect(screen.queryByTestId("computer-rule-file-import")).toBeNull());
    });

    it("starts one call per click, and leaves what did not fit unticked for another try, never re-reading what came", async () => {
        const user = userEvent.setup();
        const answer = backend.start.getMockImplementation()!;

        backend.start.mockImplementation(async (args: { files?: string[] }) => {
            if (!args.files) {
                return await answer(args);
            }

            const callId = `read-${String(backend.start.mock.calls.length)}`;

            // The second file did not fit in the first result; asked alone, it comes.
            backend.calls.set(callId, {
                files: args.files.includes("claude")
                    ? [
                          { ...LISTED[0], status: "read", text: "CLAUDE.md text" },
                          { ...LISTED[1], status: "left_out" },
                      ]
                    : [{ ...LISTED[1], status: "read", text: "AGENTS.md text" }],
                status: "completed",
            });

            return { callId };
        });
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from this computer" }));

        const find = await screen.findByRole("button", { name: "Find files" });

        await user.dblClick(find);

        expect(backend.start).toHaveBeenCalledTimes(1);

        await screen.findByRole("list", { name: "Instruction files" });
        await user.click(screen.getByRole("button", { name: "Import selected" }));

        expect(await screen.findByRole("listitem", { name: "CLAUDE.md" })).toBeDefined();

        const notImported = await screen.findByRole("list", { name: "Files not imported" });

        expect(within(notImported).getByText("~/.codex/AGENTS.md")).toBeDefined();

        const boxes = within(screen.getByRole("list", { name: "Instruction files" })).getAllByRole("checkbox");

        await waitFor(() => expect(boxes.map((box) => box.getAttribute("aria-checked"))).toEqual(["false", "true", "false", "false"]));

        await user.click(screen.getByRole("button", { name: "Import selected" }));

        expect(backend.start).toHaveBeenLastCalledWith({ deviceId: "desk", files: ["codex"] }, expect.anything());
        expect(await screen.findByRole("listitem", { name: "AGENTS.md" })).toBeDefined();
        expect(screen.getAllByRole("listitem", { name: "CLAUDE.md" })).toHaveLength(1);
    });

    it("says why when the computer is offline or the request is denied", async () => {
        const user = userEvent.setup();

        backend.start.mockRejectedValueOnce(Object.assign(new Error("offline"), { data: { code: "DEVICE_OFFLINE" } }));
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from this computer" }));
        await user.click(await screen.findByRole("button", { name: "Find files" }));

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe("Studio is offline. Open the desktop app on it and try again.");

        backend.start.mockImplementationOnce(async () => {
            backend.calls.set("denied", { status: "denied" });

            return { callId: "denied" };
        });
        await user.click(screen.getByRole("button", { name: "Find files" }));

        await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("The request was denied on Studio."));
    });

    it("says, in the person's words, when the computer's answer could not be read, and adds nothing", async () => {
        const user = userEvent.setup();
        const answer = backend.start.getMockImplementation()!;

        backend.start.mockImplementation(async (args: { files?: string[] }) => {
            if (!args.files) {
                return await answer(args);
            }

            backend.calls.set("garbled", { code: "ANSWER_UNREADABLE", error: "The computer's answer could not be read", status: "failed" });

            return { callId: "garbled" };
        });
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from this computer" }));
        await user.click(await screen.findByRole("button", { name: "Find files" }));
        await screen.findByRole("list", { name: "Instruction files" });
        await user.click(screen.getByRole("button", { name: "Import selected" }));

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe("The computer's answer could not be read. Try again, or update the desktop app on Studio.");
        expect(screen.queryByRole("listitem", { name: "CLAUDE.md" })).toBeNull();
        // The editor is free again for another import.
        await waitFor(() => expect(screen.getByRole("button", { name: "Import files" }).hasAttribute("disabled")).toBe(false));
    });

    it("drops a read the person closed the panel on, or discarded the drafts during, and frees the editor", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date", "setInterval", "clearInterval"] });

        const user = userEvent.setup();
        const answer = backend.start.getMockImplementation()!;
        let finish: () => void = () => undefined;

        backend.start.mockImplementation(async (args: { files?: string[] }) => {
            if (!args.files) {
                return await answer(args);
            }

            const callId = `slow-${String(backend.start.mock.calls.length)}`;

            backend.calls.set(callId, { phase: "prompting", status: "claimed" });
            finish = () => backend.calls.set(callId, { files: [{ ...LISTED[0], status: "read", text: "CLAUDE.md text" }], status: "completed" });

            return { callId };
        });
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from this computer" }));
        await user.click(await screen.findByRole("button", { name: "Find files" }));
        await screen.findByRole("list", { name: "Instruction files" });
        await user.click(screen.getByRole("button", { name: "Import selected" }));
        await screen.findByText("Approve the request in the desktop app on Studio.");
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        finish();

        await waitFor(() => expect(screen.getByRole("button", { name: "Import files" }).hasAttribute("disabled")).toBe(false));
        // Ten pushes later, the answer that came after the close adds nothing.
        await vi.advanceTimersByTimeAsync(100);
        expect(screen.queryByRole("listitem", { name: "CLAUDE.md" })).toBeNull();

        // A Discard while the read waits drops it too.
        await user.click(screen.getByRole("button", { name: "Add rule file" }));
        await user.click(screen.getByRole("button", { name: "Import from this computer" }));
        await user.click(await screen.findByRole("button", { name: "Find files" }));
        await screen.findByRole("list", { name: "Instruction files" });
        await user.click(screen.getByRole("button", { name: "Import selected" }));
        await screen.findByText("Approve the request in the desktop app on Studio.");
        await user.click(screen.getByRole("button", { name: "Discard changes" }));

        // Freed at once, before the computer answers: no wait on an approval nobody will use.
        await waitFor(() => expect(screen.queryByText("Approve the request in the desktop app on Studio.")).toBeNull());
        await waitFor(() => expect(screen.getByRole("button", { name: "Import files" }).hasAttribute("disabled")).toBe(false));
        expect(isDisabled(screen.getByRole("button", { name: "Import selected" }))).toBe(false);
        finish();
        await vi.advanceTimersByTimeAsync(100);
        expect(screen.queryByRole("listitem", { name: "CLAUDE.md" })).toBeNull();
    });

    it("tells a person with no paired computer how to pair one", async () => {
        const user = userEvent.setup();

        backend.devices = backend.devices.filter((device) => device.transport !== undefined);
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from this computer" }));

        expect(await screen.findByText("Pair the desktop app in Settings → Devices to import from a computer.")).toBeDefined();
        expect(screen.queryByRole("button", { name: "Find files" })).toBeNull();
    });
    it("frees the editor when the panel is closed while the read is still being sent", async () => {
        const user = userEvent.setup();
        const answer = backend.start.getMockImplementation()!;

        // The read's start never answers.
        const never = new Promise<never>(() => {
            // Never settled.
        });

        backend.start.mockImplementation(async (args: { files?: string[] }) => (args.files ? await never : await answer(args)));
        renderEditor();
        await openAndList(user);
        await user.click(screen.getByRole("button", { name: "Import selected" }));
        await screen.findByText("Waiting for Studio…");
        expect(isDisabled(screen.getByRole("button", { name: "Import files" }))).toBe(true);
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        await waitFor(() => expect(isDisabled(screen.getByRole("button", { name: "Import files" }))).toBe(false));
    });

    it("says so when the read's status cannot be read any more, and frees the editor", async () => {
        const user = userEvent.setup();
        const answer = backend.start.getMockImplementation()!;

        backend.start.mockImplementation(async (args: { files?: string[] }) => {
            if (!args.files) {
                return await answer(args);
            }

            // Waiting on the person at first, then no longer readable.
            backend.calls.set("vanished", { phase: "prompting", status: "claimed" });

            return { callId: "vanished" };
        });
        renderEditor();
        await openAndList(user);
        await user.click(screen.getByRole("button", { name: "Import selected" }));

        await screen.findByText("Approve the request in the desktop app on Studio.");
        backend.lost.add("vanished");

        const lost = await screen.findByRole("alert");

        expect(lost.textContent).toBe("Lost track of the request to Studio. Try again.");
        expect(screen.queryByText("Approve the request in the desktop app on Studio.")).toBeNull();
        await waitFor(() => expect(isDisabled(screen.getByRole("button", { name: "Import files" }))).toBe(false));
        expect(isDisabled(screen.getByRole("button", { name: "Import selected" }))).toBe(false);
        expect(screen.queryByRole("listitem", { name: "CLAUDE.md" })).toBeNull();
    });

    it("says so when the computers could not be loaded, with a way to try again", async () => {
        const user = userEvent.setup();
        let down = true;

        // Loaded again only when asked.
        backend.unpolled.add("listDevices");

        backend.listDevices.mockImplementation(() => {
            if (down) {
                throw new Error("down");
            }

            return backend.devices;
        });
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from this computer" }));

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe("Your computers could not be loaded.");
        expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
        down = false;
        await user.click(screen.getByRole("button", { name: "Try again" }));
        expect(await screen.findByText(LOOKS_FOR)).toBeDefined();
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("drops what one computer found when it goes, so nothing it listed is read from another", async () => {
        const user = userEvent.setup();

        backend.devices = [
            { _id: "desk", createdAt: 0, lastSeenAt: Date.now(), name: "Studio", platform: "linux", toolNames: [], updateRequired: false },
            { _id: "lap", createdAt: 0, lastSeenAt: Date.now(), name: "Laptop", platform: "darwin", toolNames: [], updateRequired: false },
        ];
        renderEditor();
        await openAndList(user);
        expect(backend.start).toHaveBeenLastCalledWith({ deviceId: "desk" }, expect.anything());

        // Unpaired elsewhere: the other computer takes its place, with nothing found yet.
        backend.devices = backend.devices.filter((device) => device._id !== "desk");

        await waitFor(() => expect(screen.queryByRole("list", { name: "Instruction files" })).toBeNull());
        expect(screen.queryByRole("button", { name: "Import selected" })).toBeNull();
        await user.click(screen.getByRole("button", { name: "Find files" }));
        expect(backend.start).toHaveBeenLastCalledWith({ deviceId: "lap" }, expect.anything());
    });

    it("keeps the files the project had no room for ticked, and the panel open", async () => {
        const user = userEvent.setup();

        backend.ruleFiles = ruleFiles(19);
        renderEditor();
        await openAndList(user);
        await user.click(screen.getByRole("button", { name: "Import selected" }));

        // In name order: AGENTS.md takes the last place.
        expect(await screen.findByRole("listitem", { name: "AGENTS.md" })).toBeDefined();
        expect(screen.queryByRole("listitem", { name: "CLAUDE.md" })).toBeNull();
        expect(screen.getByText((text) => text.includes("Left out: CLAUDE.md."))).toBeDefined();

        const boxes = within(screen.getByRole("list", { name: "Instruction files" })).getAllByRole("checkbox");

        await waitFor(() => expect(boxes.map((box) => box.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false"]));
        expect(screen.getByTestId("computer-rule-file-import")).toBeDefined();
        // Full now: nothing more is read until a file is removed.
        expect(isDisabled(screen.getByRole("button", { name: "Import selected" }))).toBe(true);
    });

    it("asks the computer for nothing once the project is full, even with the panel open", async () => {
        const user = userEvent.setup();

        backend.ruleFiles = ruleFiles(19);
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from this computer" }));

        const find = await screen.findByRole("button", { name: "Find files" });

        await user.click(screen.getByRole("button", { name: "Add rule file" }));
        await waitFor(() => expect(isDisabled(find)).toBe(true));
        await user.click(find);
        expect(backend.start).not.toHaveBeenCalled();
    });

    it("adds Windsurf's global rules whole and always applied, as the other tools' files", async () => {
        const user = userEvent.setup();
        const windsurf = [{ ...LISTED[3]!, size: 90, status: "found" }];

        backend.start.mockImplementation(async ({ files }: { files?: string[] }) => {
            const callId = `windsurf-${String(backend.start.mock.calls.length)}`;

            backend.calls.set(callId, files ? readAll(files, windsurf) : { files: windsurf, status: "completed" });

            return { callId };
        });
        renderEditor();
        await openAndList(user);
        await user.click(screen.getByRole("button", { name: "Import selected" }));

        const imported = await screen.findByRole("listitem", { name: "global_rules.md" });

        expect(within(imported).getByRole("radio", { name: "Always" }).getAttribute("aria-checked")).toBe("true");
        expect((within(imported).getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe("global_rules.md text");
    });

    it("lists a linked copy unticked, and makes one draft of two files that are one", async () => {
        const user = userEvent.setup();
        // `~/.codex/AGENTS.md` is a link to `~/.claude/CLAUDE.md`: the device names the first.
        const linked = [{ ...LISTED[0]! }, { ...LISTED[1]!, sameAs: "claude" }, LISTED[2]!, LISTED[3]!];

        backend.start.mockImplementation(async ({ files }: { files?: string[] }) => {
            const callId = `linked-${String(backend.start.mock.calls.length)}`;

            backend.calls.set(
                callId,
                files
                    ? {
                          files: linked.filter((file) => files.includes(file.id)).map((file) => ({ ...file, status: "read", text: "One text" })),
                          status: "completed",
                      }
                    : { files: linked, status: "completed" },
            );

            return { callId };
        });
        renderEditor();
        await openAndList(user);

        const list = screen.getByRole("list", { name: "Instruction files" });

        expect(within(list).getByText("(same file as ~/.claude/CLAUDE.md)")).toBeDefined();
        expect(
            within(list)
                .getAllByRole("checkbox")
                .map((box) => box.getAttribute("aria-checked")),
        ).toEqual(["true", "false", "false", "false"]);

        // Ticked by hand, the copy is still left out, and said so.
        await user.click(within(list).getAllByRole("checkbox")[1]!);
        await user.click(screen.getByRole("button", { name: "Import selected" }));

        expect(await screen.findByRole("listitem", { name: "CLAUDE.md" })).toBeDefined();
        expect(screen.queryByRole("listitem", { name: "AGENTS.md" })).toBeNull();
        expect(
            screen.getByText(
                "1 rule file imported. Review, then save. 1 file was left out as the same file as another picked: the same text would apply twice.",
            ),
        ).toBeDefined();
        await waitFor(() => expect(screen.queryByTestId("computer-rule-file-import")).toBeNull());
    });

    it("makes one draft of two files with the same text from a desktop that does not say they are linked", async () => {
        const user = userEvent.setup();

        backend.start.mockImplementation(async ({ files }: { files?: string[] }) => {
            const callId = `same-${String(backend.start.mock.calls.length)}`;

            backend.calls.set(
                callId,
                files
                    ? {
                          files: LISTED.filter((file) => files.includes(file.id)).map((file) => ({ ...file, status: "read", text: "Same text" })),
                          status: "completed",
                      }
                    : { files: LISTED, status: "completed" },
            );

            return { callId };
        });
        renderEditor();
        await openAndList(user);
        await user.click(screen.getByRole("button", { name: "Import selected" }));

        expect(backend.start).toHaveBeenLastCalledWith({ deviceId: "desk", files: ["claude", "codex"] }, expect.anything());
        expect(await screen.findByRole("listitem", { name: "CLAUDE.md" })).toBeDefined();
        expect(screen.queryByRole("listitem", { name: "AGENTS.md" })).toBeNull();
        await waitFor(() => expect(screen.queryByTestId("computer-rule-file-import")).toBeNull());
    });

    it("shows a computer that stops checking in as offline while the panel is open", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date", "setInterval", "clearInterval"] });

        const user = userEvent.setup();

        // Seen 70 s ago: online for 5 s more.
        backend.devices = [
            { _id: "desk", createdAt: 0, lastSeenAt: Date.now() - 70_000, name: "Studio", platform: "linux", toolNames: [], updateRequired: false },
        ];
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from this computer" }));

        const find = await screen.findByRole("button", { name: "Find files" });

        expect(isDisabled(find)).toBe(false);
        vi.advanceTimersByTime(10_000);
        await waitFor(() => expect(isDisabled(find)).toBe(true));
    });

    it("starts each call online-only, and refuses to start one while offline", async () => {
        const user = userEvent.setup();

        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from this computer" }));
        await screen.findByRole("button", { name: "Find files" });

        expect(backend.startOptions.at(-1)).toEqual([{ networkMode: "always", retry: 0 }, { onlineOnly: true }]);

        onlineManager.setOnline(false);
        await user.click(screen.getByRole("button", { name: "Find files" }));

        const offline = await screen.findByRole("alert");

        expect(offline.textContent).toBe("You are offline. Reconnect and try again.");
        expect(backend.start).not.toHaveBeenCalled();
    });

    it("says the connection is down when Lunora refuses the online-only start", async () => {
        const user = userEvent.setup();

        backend.start.mockRejectedValue(Object.assign(new Error("offline"), { code: "OFFLINE_NOT_QUEUED" }));
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from this computer" }));
        await user.click(await screen.findByRole("button", { name: "Find files" }));

        const refused = await screen.findByRole("alert");

        expect(refused.textContent).toBe("You are offline. Reconnect and try again.");
    });

    it("keeps a ticked file the answer left out, or sent without text, ticked and says so", async () => {
        const user = userEvent.setup();

        backend.start.mockImplementation(async ({ files }: { files?: string[] }) => {
            const callId = `partial-${String(backend.start.mock.calls.length)}`;

            // The read's answer carries CLAUDE.md alone: AGENTS.md was dropped on the way.
            backend.calls.set(callId, files ? readAll(["claude"]) : { files: LISTED, status: "completed" });

            return { callId };
        });
        renderEditor();
        await openAndList(user);
        await user.click(screen.getByRole("button", { name: "Import selected" }));

        expect(await screen.findByRole("listitem", { name: "CLAUDE.md" })).toBeDefined();

        const left = await screen.findByRole("list", { name: "Files not imported" });

        expect(left.textContent).toContain("~/.codex/AGENTS.md");
        expect(left.textContent).toContain("(not in the computer's answer: try again)");

        const boxes = within(screen.getByRole("list", { name: "Instruction files" })).getAllByRole("checkbox");

        await waitFor(() => expect(boxes.map((box) => box.getAttribute("aria-checked"))).toEqual(["false", "true", "false", "false"]));
        expect(screen.getByTestId("computer-rule-file-import")).toBeDefined();

        // A Discard after the read ended takes the draft, not what the panel says about that read.
        await user.click(screen.getByRole("button", { name: "Discard changes" }));
        await waitFor(() => expect(screen.queryByRole("listitem", { name: "CLAUDE.md" })).toBeNull());
        expect(screen.getByRole("list", { name: "Files not imported" })).toBeDefined();
    });

    it("imports only the files asked for, even when the answer carries another it listed", async () => {
        const user = userEvent.setup();

        backend.start.mockImplementation(async ({ files }: { files?: string[] }) => {
            const callId = `extra-${String(backend.start.mock.calls.length)}`;

            // Asked for CLAUDE.md alone, the computer sends AGENTS.md too.
            backend.calls.set(callId, files ? readAll(["claude", "codex"]) : { files: LISTED, status: "completed" });

            return { callId };
        });
        renderEditor();
        await openAndList(user);
        await user.click(within(screen.getByRole("list", { name: "Instruction files" })).getAllByRole("checkbox")[1]!);
        await user.click(screen.getByRole("button", { name: "Import selected" }));

        expect(await screen.findByRole("listitem", { name: "CLAUDE.md" })).toBeDefined();
        expect(screen.getByText("1 rule file imported. Review, then save.")).toBeDefined();
        expect(screen.queryByRole("listitem", { name: "AGENTS.md" })).toBeNull();
    });

    it("names the computer a read went to, even once it is unpaired and another is chosen", async () => {
        const user = userEvent.setup();
        let deny: () => void = () => undefined;
        const answer = backend.start.getMockImplementation()!;

        backend.devices = [
            { _id: "desk", createdAt: 0, lastSeenAt: Date.now(), name: "Studio", platform: "linux", toolNames: [], updateRequired: false },
            { _id: "lap", createdAt: 0, lastSeenAt: Date.now(), name: "Laptop", platform: "darwin", toolNames: [], updateRequired: false },
        ];
        backend.start.mockImplementation(async (args: { files?: string[] }) => {
            if (!args.files) {
                return await answer(args);
            }

            backend.calls.set("asked", { phase: "prompting", status: "claimed" });
            deny = () => backend.calls.set("asked", { status: "denied" });

            return { callId: "asked" };
        });
        renderEditor();
        await openAndList(user);
        await user.click(screen.getByRole("button", { name: "Import selected" }));
        await screen.findByText("Approve the request in the desktop app on Studio.");
        backend.devices = backend.devices.filter((device) => device._id !== "desk");
        await waitFor(() => expect(screen.queryByRole("radio")).toBeNull());
        deny();

        const denied = await screen.findByRole("alert");

        expect(denied.textContent).toBe("The request was denied on Studio.");
    });

    it("says why Find files cannot be clicked when the one computer is offline", async () => {
        const user = userEvent.setup();

        backend.devices = [
            { _id: "desk", createdAt: 0, lastSeenAt: Date.now() - 3_600_000, name: "Studio", platform: "linux", toolNames: [], updateRequired: false },
        ];
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from this computer" }));

        const find = await screen.findByRole("button", { name: "Find files" });
        const note = screen.getByText("Studio is offline. Open the desktop app on it to continue.");

        expect(isDisabled(find)).toBe(true);
        expect(find.getAttribute("aria-describedby")).toBe(note.id);
    });

    it("says the computers could not be loaded even over a list loaded before", async () => {
        const user = userEvent.setup();

        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from this computer" }));
        await screen.findByText(LOOKS_FOR);
        backend.listDevices.mockImplementation(() => {
            throw new Error("down");
        });

        const notLoaded = await screen.findByRole("alert");

        expect(notLoaded.textContent).toBe("Your computers could not be loaded.");
        expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
        expect(screen.getByText(LOOKS_FOR)).toBeDefined();
    });

    it("reads a waiting call once now and then, so a live query gone quiet does not strand the read", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date", "setInterval", "clearInterval"] });

        const user = userEvent.setup();

        // The live status stays on its first push, however often it is refetched.
        backend.quiet.add("getGlobalInstructionsCall");
        backend.start.mockImplementation(async () => {
            const callId = `quiet-${String(backend.start.mock.calls.length)}`;

            backend.calls.set(callId, { phase: "prompting", status: "claimed" });

            return { callId };
        });
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from this computer" }));
        await user.click(await screen.findByRole("button", { name: "Find files" }));
        await screen.findByText("Approve the request in the desktop app on Studio.");
        backend.calls.set("quiet-1", { files: LISTED, status: "completed" });
        vi.advanceTimersByTime(15_000);

        expect(await screen.findByRole("list", { name: "Instruction files" })).toBeDefined();

        // Ten refetches of the live query, each still answering "claimed", do not put the call back to waiting.
        await vi.advanceTimersByTimeAsync(100);
        expect(screen.getByRole("list", { name: "Instruction files" })).toBeDefined();
        expect(screen.queryByText("Approve the request in the desktop app on Studio.")).toBeNull();

        await user.click(screen.getByRole("button", { name: "Import selected" }));
        await screen.findByText("Approve the request in the desktop app on Studio.");
        backend.calls.set("quiet-2", readAll(["claude", "codex"]));
        vi.advanceTimersByTime(15_000);

        expect(await screen.findByRole("listitem", { name: "CLAUDE.md" })).toBeDefined();
        expect(screen.getByRole("listitem", { name: "AGENTS.md" })).toBeDefined();
    });

    it("gives up on a call still waiting past its deadline, and frees the editor", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date", "setInterval", "clearInterval"] });

        const user = userEvent.setup();
        const answer = backend.start.getMockImplementation()!;

        backend.start.mockImplementation(async (args: { files?: string[] }) => {
            if (!args.files) {
                return await answer(args);
            }

            // Never answered, and never marked expired either.
            backend.calls.set("stuck", { phase: "prompting", status: "claimed" });

            return { callId: "stuck" };
        });
        renderEditor();
        await openAndList(user);
        await user.click(screen.getByRole("button", { name: "Import selected" }));
        await screen.findByText("Approve the request in the desktop app on Studio.");
        vi.advanceTimersByTime(5 * 60_000 + 40_000);

        const gaveUp = await screen.findByRole("alert");

        expect(gaveUp.textContent).toBe("Lost track of the request to Studio. Try again.");
        await waitFor(() => expect(isDisabled(screen.getByRole("button", { name: "Import files" }))).toBe(false));
    });
});
