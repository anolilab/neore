// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { showError } from "@/lib/toast";

import ComposerThreadPermissionMode from "./composer-permission-mode";

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
        isOwner: true,
        save: vi.fn(async (_input: unknown) => null),
        thread: { _id: "t1", permissionMode: "full" } as { _id: string; permissionMode?: string; runner?: "host" } | null,
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

const renderControl = () =>
    render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
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
        renderControl();

        await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
    });

    it("offers the four modes with a description and writes the chosen one", async () => {
        renderControl();
        fireEvent.click(await screen.findByRole("button", { name: "Permission mode: Full access" }));

        expect(await screen.findByText("Anything that is not a plain lookup asks first")).toBeTruthy();
        expect(screen.getAllByRole("menuitemradio")).toHaveLength(4);

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
});
