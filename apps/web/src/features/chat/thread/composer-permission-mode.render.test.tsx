// @vitest-environment jsdom

import { COMPARISON_COLUMN_MODE_CODE, THREAD_PERMISSION_MODES } from "@neore/backend/chat/permission-mode";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePromptQueueStore } from "@/features/chat/core/stores/prompt-queue-store";
import { showError } from "@/lib/toast";

import ComposerThreadPermissionMode, { usePermissionModeSaving } from "./composer-permission-mode";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

const SUPERVISED_PATTERN = /Supervised/;

const state = vi.hoisted(() => {
    return {
        effective: null as string | null,
        isOwner: true,
        save: vi.fn(async (_input: unknown) => null),
        thread: { _id: "t1", permissionMode: "full" } as {
            _id: string;
            lockedAt?: number;
            model?: string;
            permissionMode?: string;
            runner?: "host";
            userId?: string;
        } | null,
    };
});

vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatIsRunning: () => false,
        useChatThread: () => {
            return { thread: state.thread, threadId: state.thread?._id ?? "" };
        },
    };
});
vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                chat: {
                    functions: {
                        getThread: {
                            queryKey: (args: unknown) => ["thread", args],
                        },
                    },
                    sharing: {
                        getThreadAccess: {
                            queryOptions: () => {
                                return {
                                    queryFn: async () => {
                                        return { isOwner: state.isOwner };
                                    },
                                    queryKey: ["access", state.isOwner],
                                };
                            },
                        },
                    },
                    thread_state: {
                        getEffectivePermissionMode: {
                            queryKey: (args: unknown) => ["effective", args],
                            queryOptions: () => {
                                return {
                                    queryFn: async () => state.effective,
                                    queryKey: ["effective", state.isOwner],
                                };
                            },
                        },
                        setThreadPermissionMode: {
                            mutationOptions: () => {
                                return { mutationFn: state.save };
                            },
                        },
                    },
                },
            };
        },
    };
});
vi.mock("@/lib/toast", () => {
    return { showError: vi.fn() };
});

const renderControl = (client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) =>
    render(
        <QueryClientProvider client={client}>
            <ComposerThreadPermissionMode />
        </QueryClientProvider>,
    );

beforeEach(() => {
    // The menu's positioner observes its anchor; jsdom has no ResizeObserver and the shared setup stub is not constructible.
    vi.stubGlobal(
        "ResizeObserver",

        class {
            observe = vi.fn();

            unobserve = vi.fn();

            disconnect = vi.fn();
        },
    );
    state.isOwner = true;
    state.thread = { _id: "t1", permissionMode: "full" };
    state.save.mockClear();
    state.effective = null;
    usePromptQueueStore.setState({ queues: {} });
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe("permission mode control", () => {
    it("shows the stored mode", async () => {
        renderControl();

        expect(await screen.findByRole("button", { name: "Permission mode: Full access" })).toBeTruthy();
    });

    it("shows Auto when nothing is stored", async () => {
        state.thread = { _id: "t1" };
        renderControl();

        expect(await screen.findByRole("button", { name: "Permission mode: Auto" })).toBeTruthy();
    });

    it("is hidden for a host thread and for a viewer who is not the owner", async () => {
        state.thread = { _id: "t1", runner: "host" };
        const { unmount } = renderControl();

        await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
        unmount();

        state.thread = { _id: "t1", permissionMode: "supervised" };
        state.isOwner = false;
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        renderControl(client);

        // The menu is also absent while the access read is pending, so absence proves nothing until that read has answered.
        await waitFor(() => expect(client.getQueryState(["access", false])?.status).toBe("success"));
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("shows the menu for an unlocked chat that is locked and has no stored mode", async () => {
        state.thread = { _id: "t1", lockedAt: 1, model: "m", userId: "owner" };
        renderControl();

        expect(await screen.findByRole("button", { name: "Permission mode: Auto" })).toBeTruthy();
    });

    it("shows the menu for an imported chat that is locked and has no model", async () => {
        state.thread = { _id: "t1", lockedAt: 1, userId: "owner" };
        renderControl();

        expect(await screen.findByRole("button", { name: "Permission mode: Auto" })).toBeTruthy();
    });

    it("is hidden for a locked stub, which carries no user", async () => {
        state.thread = { _id: "t1", lockedAt: 1 };
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        renderControl(client);

        // The menu is also absent while the access read is pending, so absence is checked once that read has answered.
        await waitFor(() => expect(client.getQueryState(["access", true])?.status).toBe("success"));
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("reports a save in flight, so the composer can wait before it sends", async () => {
        state.save.mockImplementationOnce(() => new Promise<null>(() => {}));
        const SavingProbe = () => {
            const saving = usePermissionModeSaving("t1");

            return <span>{saving ? "saving" : "idle"}</span>;
        };

        render(
            <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
                <ComposerThreadPermissionMode />
                <SavingProbe />
            </QueryClientProvider>,
        );

        expect(await screen.findByText("idle")).toBeTruthy();
        fireEvent.click(await screen.findByRole("button", { name: "Permission mode: Full access" }));
        fireEvent.click(screen.getByRole("menuitemradio", { name: SUPERVISED_PATTERN }));

        expect(await screen.findByText("saving")).toBeTruthy();
    });

    it("shows the mode a comparison column runs under, when the column has none of its own", async () => {
        state.thread = { _id: "t1" };
        state.effective = "supervised";
        renderControl();

        expect(await screen.findByRole("button", { name: "Permission mode: Supervised" })).toBeTruthy();
    });

    it("offers the four modes with a description and writes the chosen one", async () => {
        renderControl();
        fireEvent.click(await screen.findByRole("button", { name: "Permission mode: Full access" }));

        expect(await screen.findByText("Anything that is not a plain lookup asks first")).toBeTruthy();
        // The menu offers the backend's modes: the count follows the shared list, not a copy of it.
        expect(screen.getAllByRole("menuitemradio")).toHaveLength(THREAD_PERMISSION_MODES.length);

        fireEvent.click(screen.getByRole("menuitemradio", { name: SUPERVISED_PATTERN }));

        await waitFor(() => expect(state.save).toHaveBeenCalledTimes(1));
        expect(state.save.mock.calls[0]?.[0]).toStrictEqual({ mode: "supervised", threadId: "t1" });

        // Let the saved mode's follow-up (the cache refresh) run, then check that nothing failed.
        await act(async () => {
            await new Promise((resolve) => {
                setTimeout(resolve, 0);
            });
        });
        expect(showError).not.toHaveBeenCalled();
    });

    it("holds the queued prompts when the save fails, so they do not go out under the stored mode", async () => {
        state.save.mockImplementationOnce(async () => {
            throw new Error("save refused");
        });
        usePromptQueueStore.getState().hydrate("t1");
        usePromptQueueStore.getState().enqueue("t1", { attachments: [], text: "queued" });

        renderControl();
        fireEvent.click(await screen.findByRole("button", { name: "Permission mode: Full access" }));
        fireEvent.click(screen.getByRole("menuitemradio", { name: SUPERVISED_PATTERN }));

        await waitFor(() => expect(showError).toHaveBeenCalled());
        expect(usePromptQueueStore.getState().queues.t1?.paused).toBe(true);
    });

    it("does not hold the queued prompts for a mode refused on a comparison column, which saved nothing", async () => {
        vi.mocked(showError).mockClear();
        state.save.mockImplementationOnce(async () => {
            throw Object.assign(new Error("A comparison column takes its comparison's mode: change the mode on the comparison"), {
                data: { code: COMPARISON_COLUMN_MODE_CODE },
            });
        });
        usePromptQueueStore.getState().hydrate("t1");
        usePromptQueueStore.getState().enqueue("t1", { attachments: [], text: "queued" });

        renderControl();
        fireEvent.click(await screen.findByRole("button", { name: "Permission mode: Full access" }));
        fireEvent.click(screen.getByRole("menuitemradio", { name: SUPERVISED_PATTERN }));

        await waitFor(() => expect(showError).toHaveBeenCalled());
        expect(usePromptQueueStore.getState().queues.t1?.paused).toBe(false);
    });

    it("keeps a selection still saving when the viewer goes to another chat and comes back", async () => {
        state.thread = { _id: "A", permissionMode: "auto" };
        state.save.mockImplementationOnce(() => new Promise<null>(() => {}));
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        // Keyed by the chat, as the composer that renders it is: a change of chat remounts the control.
        const control = () => (
            <QueryClientProvider client={client}>
                <ComposerThreadPermissionMode key={state.thread?._id} />
            </QueryClientProvider>
        );
        const view = render(control());

        fireEvent.click(await screen.findByRole("button", { name: "Permission mode: Auto" }));
        fireEvent.click(screen.getByRole("menuitemradio", { name: SUPERVISED_PATTERN }));
        expect(await screen.findByRole("button", { name: "Permission mode: Supervised" })).toBeTruthy();

        state.thread = { _id: "B", permissionMode: "full" };
        view.rerender(control());
        expect(await screen.findByRole("button", { name: "Permission mode: Full access" })).toBeTruthy();

        state.thread = { _id: "A", permissionMode: "auto" };
        view.rerender(control());
        expect(await screen.findByRole("button", { name: "Permission mode: Supervised" })).toBeTruthy();
    });

    it("does not show a selection still saving for one chat in another chat that stores a different mode", async () => {
        state.thread = { _id: "t1", permissionMode: "auto" };
        state.save.mockImplementationOnce(() => new Promise<null>(() => {}));
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const view = render(
            <QueryClientProvider client={client}>
                <ComposerThreadPermissionMode />
            </QueryClientProvider>,
        );

        fireEvent.click(await screen.findByRole("button", { name: "Permission mode: Auto" }));
        fireEvent.click(screen.getByRole("menuitemradio", { name: SUPERVISED_PATTERN }));
        expect(await screen.findByRole("button", { name: "Permission mode: Supervised" })).toBeTruthy();

        // The viewer opens a Full access chat before the save settles.
        state.thread = { _id: "t2", permissionMode: "full" };
        view.rerender(
            <QueryClientProvider client={client}>
                <ComposerThreadPermissionMode />
            </QueryClientProvider>,
        );

        expect(await screen.findByRole("button", { name: "Permission mode: Full access" })).toBeTruthy();
    });
});
