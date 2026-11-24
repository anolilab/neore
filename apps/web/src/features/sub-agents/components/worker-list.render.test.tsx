/**
 * The worker list's archive button: with the archive setting on it asks first and archives only on confirm; with it off, or
 * with no answer yet, the setting's rule decides; and a worker that starts working while the dialog is open is not archived.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import WorkerList from "./worker-list";

interface WorkerRow {
    activeRunId: string | null;
    archived: boolean;
    lastActivityAt: number | null;
    name: string;
    postFailed: string | null;
    quietAfterMs: number;
    state: "idle" | "queued" | "running";
    stopping: boolean;
    workerId: string;
}

const { harness } = vi.hoisted(() => {
    return {
        harness: {
            isImpersonating: false,
            /** The workers the list query returns; a test may replace them while the list is mounted. */
            workers: [] as WorkerRow[],
            settings: undefined as undefined | { confirmBeforeArchiveChat?: boolean },
            updateThread: vi.fn(),
        },
    };
});

const idleWorker = (overrides: Partial<WorkerRow> = {}): WorkerRow => {
    return {
        activeRunId: null,
        archived: false,
        lastActivityAt: null,
        name: "Plan A",
        postFailed: null,
        quietAfterMs: 0,
        state: "idle",
        stopping: false,
        workerId: "worker-1",
        ...overrides,
    };
};

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { t };
        },
    };
});

vi.mock("@neore/client-runtime", () => {
    return { useUnlockProof: () => undefined };
});

vi.mock("@tanstack/react-router", () => {
    return {
        Link: ({ children }: { children: unknown }) => children,
    };
});

vi.mock("@/features/admin/hooks/use-is-impersonating", () => {
    return { useImpersonating: () => harness.isImpersonating };
});

vi.mock("@/features/auth/hooks/use-user-settings", () => {
    return {
        useUserSettings: () => {
            return { data: harness.settings };
        },
    };
});

vi.mock("@/features/chat/core/hooks/use-threads", () => {
    return { useUpdateThread: () => harness.updateThread };
});

vi.mock("@/hooks/use-after-first-paint", () => {
    return { default: () => true };
});

vi.mock("@/features/sub-agents/hooks/use-stop-worker", () => {
    return {
        quietMinutesAt: () => null,
        useNow: () => 0,
        useQuietMinutes: () => null,
        useStopWorker: () => {
            return { isPending: false, stopRun: vi.fn() };
        },
    };
});

vi.mock("@/lib/toast", () => {
    return { showError: vi.fn() };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                sub_agents: {
                    functions: {
                        listWorkers: {
                            // The workers are read from the query cache, so a test can change them while the dialog is open.
                            queryOptions: () => {
                                return { queryFn: () => [...harness.workers], queryKey: ["listWorkers"] };
                            },
                        },
                    },
                },
            };
        },
    };
});

const mountList = (workers: WorkerRow[]) => {
    harness.workers = workers;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(createElement(QueryClientProvider, { client: queryClient }, createElement(WorkerList, { threadId: "lead-1" })));

    return queryClient;
};

const archiveButton = async () => screen.findByRole("button", { name: "Archive Plan A" });

describe("worker list archive confirmation", () => {
    beforeEach(() => {
        harness.isImpersonating = false;
        harness.settings = { confirmBeforeArchiveChat: false };
        harness.updateThread.mockReset();
        harness.updateThread.mockResolvedValue(undefined);
    });

    it("archives an idle worker at once when the archive setting is off", async () => {
        mountList([idleWorker()]);

        fireEvent.click(await archiveButton());

        expect(screen.queryByText("Archive this chat?")).toBeNull();
        expect(harness.updateThread).toHaveBeenCalledWith({ status: "archived", threadId: "worker-1" });
    });

    it("asks first when the archive setting is on, and archives only once confirmed", async () => {
        harness.settings = { confirmBeforeArchiveChat: true };
        mountList([idleWorker()]);

        fireEvent.click(await archiveButton());

        expect(await screen.findByText("Archive this chat?")).toBeTruthy();
        expect(harness.updateThread).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Archive" }));

        await waitFor(() => expect(harness.updateThread).toHaveBeenCalledWith({ status: "archived", threadId: "worker-1" }));
        expect(harness.updateThread).toHaveBeenCalledTimes(1);
    });

    it("leaves the worker alone when the archive dialog is cancelled", async () => {
        harness.settings = { confirmBeforeArchiveChat: true };
        mountList([idleWorker()]);

        fireEvent.click(await archiveButton());
        fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

        await waitFor(() => expect(screen.queryByText("Archive this chat?")).toBeNull());
        expect(harness.updateThread).not.toHaveBeenCalled();
    });

    it("asks while the settings are still loading, so an answer never skips a prompt", async () => {
        harness.settings = undefined;
        mountList([idleWorker()]);

        fireEvent.click(await archiveButton());

        expect(await screen.findByText("Archive this chat?")).toBeTruthy();
        expect(harness.updateThread).not.toHaveBeenCalled();
    });

    it("does not archive a worker that started working while the dialog was open", async () => {
        harness.settings = { confirmBeforeArchiveChat: true };
        const queryClient = mountList([idleWorker()]);

        fireEvent.click(await archiveButton());
        expect(await screen.findByText("Archive this chat?")).toBeTruthy();

        act(() => {
            queryClient.setQueryData(["listWorkers"], [idleWorker({ state: "running", activeRunId: "run-1" })]);
        });
        // The cache notifies on a timer, so wait for the list to show the worker working before confirming.
        expect(await screen.findByText("Working")).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "Archive" }));

        expect(harness.updateThread).not.toHaveBeenCalled();
    });
});
