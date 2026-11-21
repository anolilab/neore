import { QueryClient, QueryClientProvider, skipToken } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

type Row = { error?: string; files?: unknown[]; phase?: string; status: string };

const backend = vi.hoisted(() => {
    return {
        calls: new Map<string, Row>(),
        devices: [] as Record<string, unknown>[],
        listDevices: vi.fn(),
        start: vi.fn(),
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    // Answered again every few milliseconds, as a live query is pushed every change.
    const polled = (key: string, read: (args: never) => unknown) => {
        return {
            queryOptions: (args: unknown) =>
                args === skipToken
                    ? { queryFn: skipToken, queryKey: [key] }
                    : { queryFn: async () => structuredClone(read(args as never)) ?? null, queryKey: [key, args], refetchInterval: 10 },
        };
    };

    return {
        useCRPC: () => {
            return {
                devices: {
                    functions: { listDevices: polled("listDevices", () => backend.listDevices()) },
                    global_instructions: {
                        getGlobalInstructionsCall: polled("getGlobalInstructionsCall", ({ callId }: { callId: string }) => backend.calls.get(callId)),
                        startGlobalInstructionsCall: {
                            mutationOptions: () => {
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
                                        return { canEdit: true, files: [], revision: "r1" };
                                    },
                                    queryKey: ["listProjectRuleFiles", args],
                                };
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

const renderEditor = () =>
    render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <ProjectRuleFiles projectId="p1" />
        </QueryClientProvider>,
    );

beforeEach(() => {
    backend.calls.clear();
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
            backend.calls.set(
                callId,
                files
                    ? {
                          files: LISTED.filter((file) => files.includes(file.id)).map((file) => {
                              return { ...file, status: "read", text: `${file.name} text` };
                          }),
                          status: "completed",
                      }
                    : { files: LISTED, status: "completed" },
            );
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

            // The second file did not fit in the one result.
            backend.calls.set("read", {
                files: [
                    { ...LISTED[0], status: "read", text: "CLAUDE.md text" },
                    { ...LISTED[1], status: "left_out" },
                ],
                status: "completed",
            });

            return { callId: "read" };
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

    it("tells a person with no paired computer how to pair one", async () => {
        const user = userEvent.setup();

        backend.devices = backend.devices.filter((device) => device.transport !== undefined);
        renderEditor();
        await user.click(await screen.findByRole("button", { name: "Import from this computer" }));

        expect(await screen.findByText("Pair the desktop app in Settings → Devices to import from a computer.")).toBeDefined();
        expect(screen.queryByRole("button", { name: "Find files" })).toBeNull();
    });
});
