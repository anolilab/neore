/**
 * "Fork here" on a coding agent's chat: offered only to an agent that forks sessions, says the fork shares the folder (and a git
 * worktree in it) before anything is made, and forks the chat it was opened on, once per click.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    return {
        calls: [] as unknown[],
        error: undefined as (Error & { code?: string; data?: { code?: string } }) | undefined,
        infos: [] as string[],
        result: undefined as { started: boolean; threadId?: string } | undefined,
        hold: undefined as Promise<void> | undefined,
        release: undefined as (() => void) | undefined,
        navigated: [] as unknown[],
        successes: [] as { action?: { label: string; onClick: () => void }; message: string }[],
        toasts: [] as string[],
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { i18n: { locale: "en" }, t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});
vi.mock("@tanstack/react-router", () => {
    return {
        useNavigate: () => async (options: unknown) => {
            harness.navigated.push(options);
        },
    };
});
vi.mock("sonner", () => {
    return {
        toast: {
            error: (message: string) => {
                harness.toasts.push(message);
            },
            info: (message: string) => {
                harness.infos.push(message);
            },
            success: (message: string, options?: { action?: { label: string; onClick: () => void } }) => {
                harness.successes.push({ action: options?.action, message });
            },
        },
    };
});
vi.mock("@/features/auth/lib/utilities", () => {
    return { getLocalizedError: ({ error }: { error: Error }) => error.message };
});
vi.mock("@neore/backend/api", () => {
    return { api: { acp: { remote: { forkHostThread: "acp.remote.forkHostThread" } } } };
});
vi.mock("@/lib/lunora/crpc", () => {
    return {
        useLunoraActionOptions: () => {
            return {
                mutationFn: async (args: unknown) => {
                    harness.calls.push(args);

                    if (harness.hold !== undefined) {
                        await harness.hold;
                    }

                    if (harness.error !== undefined) {
                        throw harness.error;
                    }

                    return harness.result ?? { started: true, threadId: "thread-fork" };
                },
            };
        },
    };
});

const { default: HostFork } = await import("./host-fork");

const FORKS = { groups: { sessions: { fork: { degradation: "none", supported: true } } }, reportedAt: 1, version: 1 } as never;
const CANNOT = { groups: { sessions: { fork: { reason: "not_offered", supported: false } } }, reportedAt: 1, version: 1 } as never;
const WARNING = /Both chats work in that folder, so they can change the same files, and a git worktree there is shared too\./u;

const queryClient = () => new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
const tree = (capabilities: unknown, disabled: boolean, client: QueryClient) => (
    <QueryClientProvider client={client}>
        <HostFork capabilities={capabilities as never} disabled={disabled} threadId="thread-1" />
    </QueryClientProvider>
);
const mount = (capabilities: unknown, disabled = false) => render(tree(capabilities, disabled, queryClient()));

beforeEach(() => {
    harness.calls = [];
    harness.error = undefined;
    harness.infos = [];
    harness.result = undefined;
    harness.hold = undefined;
    harness.release = undefined;
    harness.navigated = [];
    harness.successes = [];
    harness.toasts = [];
});

describe("HostFork", () => {
    it.each([
        ["an agent that does not fork sessions", CANNOT],
        ["a report that says nothing", { groups: {}, reportedAt: 0, version: 1 }],
        ["no report", undefined],
    ])("offers nothing for %s", (_name, capabilities) => {
        mount(capabilities);

        expect(screen.queryByRole("button", { name: "Fork here" })).toBeNull();
    });

    it("warns that the fork shares the folder and a worktree in it, and forks nothing until it is confirmed", async () => {
        const user = userEvent.setup();

        mount(FORKS);
        await user.click(screen.getByRole("button", { name: "Fork here" }));

        expect(await screen.findByText(WARNING)).toBeTruthy();
        expect(screen.getByText("Fork this chat?")).toBeTruthy();
        expect(harness.calls).toEqual([]);

        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(harness.calls).toEqual([]);
    });

    it("forks the chat it was opened on, with an id for the click, and opens the new chat", async () => {
        const user = userEvent.setup();

        mount(FORKS);
        await user.click(screen.getByRole("button", { name: "Fork here" }));
        await screen.findByText(WARNING);
        await user.click(screen.getAllByRole("button", { name: "Fork here" }).at(-1)!);

        await waitFor(() => expect(harness.calls).toHaveLength(1));
        expect(harness.calls[0]).toEqual({ clientId: expect.any(String), threadId: "thread-1" });
        await waitFor(() => expect(harness.navigated).toEqual([{ params: { threadId: "thread-fork" }, to: "/chat/$threadId" }]));
    });

    it("tells the person why a fork was refused and stays on the chat", async () => {
        const user = userEvent.setup();

        harness.error = new Error("This agent cannot fork a session.");
        mount(FORKS);
        await user.click(screen.getByRole("button", { name: "Fork here" }));
        await screen.findByText(WARNING);
        await user.click(screen.getAllByRole("button", { name: "Fork here" }).at(-1)!);

        await waitFor(() => expect(harness.toasts).toEqual(["This agent cannot fork a session."]));
        expect(harness.navigated).toEqual([]);
    });

    it("offers the new chat in a toast, and does not move the person, when the fork finishes after they left the chat", async () => {
        const user = userEvent.setup();
        const view = mount(FORKS);

        harness.hold = new Promise<void>((resolve) => {
            harness.release = resolve;
        });
        await user.click(screen.getByRole("button", { name: "Fork here" }));
        await screen.findByText(WARNING);
        await user.click(screen.getAllByRole("button", { name: "Fork here" }).at(-1)!);
        await waitFor(() => expect(harness.calls).toHaveLength(1));

        // The person moves to another chat while the fork is on its way.
        view.unmount();
        harness.release?.();

        await waitFor(() => expect(harness.successes).toHaveLength(1));
        expect(harness.navigated).toEqual([]);
        expect(harness.successes[0]?.message).toBe("The chat was forked.");
        expect(harness.successes[0]?.action?.label).toBe("Open");

        harness.successes[0]?.action?.onClick();
        expect(harness.navigated).toEqual([{ params: { threadId: "thread-fork" }, to: "/chat/$threadId" }]);
    });

    it("tries the same id again after a failure whose outcome is unknown, so a fork whose answer was lost is not made twice", async () => {
        const user = userEvent.setup();

        harness.error = new Error("network lost");
        mount(FORKS);
        await user.click(screen.getByRole("button", { name: "Fork here" }));
        await screen.findByText(WARNING);
        await user.click(screen.getAllByRole("button", { name: "Fork here" }).at(-1)!);
        await waitFor(() => expect(harness.toasts).toHaveLength(1));

        // The dialog is still open after a failure: confirming again is the retry.
        harness.error = undefined;
        await user.click(screen.getAllByRole("button", { name: "Fork here" }).at(-1)!);
        await waitFor(() => expect(harness.calls).toHaveLength(2));

        const [first, second] = harness.calls as { clientId: string }[];

        expect(second?.clientId).toBe(first?.clientId);
    });

    it.each([
        ["BAD_REQUEST", { code: "BAD_REQUEST" }],
        ["FORBIDDEN", { code: "FORBIDDEN" }],
        ["NOT_FOUND", { data: { code: "NOT_FOUND" } }],
    ])("starts a new fork on the next click after the server refused the call outright (%s)", async (_name, fields) => {
        const user = userEvent.setup();

        harness.error = Object.assign(new Error("refused"), fields);
        mount(FORKS);
        await user.click(screen.getByRole("button", { name: "Fork here" }));
        await screen.findByText(WARNING);
        await user.click(screen.getAllByRole("button", { name: "Fork here" }).at(-1)!);
        await waitFor(() => expect(harness.toasts).toHaveLength(1));

        harness.error = undefined;
        await user.click(screen.getAllByRole("button", { name: "Fork here" }).at(-1)!);
        await waitFor(() => expect(harness.calls).toHaveLength(2));

        const [first, second] = harness.calls as { clientId: string }[];

        expect(second?.clientId).not.toBe(first?.clientId);
    });

    it("keeps the id after a conflict the server asked to retry, which names a fork that may be in flight", async () => {
        const user = userEvent.setup();

        harness.error = Object.assign(new Error("This fork is still being made. Try again in a moment."), { code: "CONFLICT" });
        mount(FORKS);
        await user.click(screen.getByRole("button", { name: "Fork here" }));
        await screen.findByText(WARNING);
        await user.click(screen.getAllByRole("button", { name: "Fork here" }).at(-1)!);
        await waitFor(() => expect(harness.toasts).toHaveLength(1));

        harness.error = undefined;
        await user.click(screen.getAllByRole("button", { name: "Fork here" }).at(-1)!);
        await waitFor(() => expect(harness.calls).toHaveLength(2));

        const [first, second] = harness.calls as { clientId: string }[];

        expect(second?.clientId).toBe(first?.clientId);
    });

    it("cannot be confirmed from an open dialog once the agent is starting again", async () => {
        const user = userEvent.setup();
        const client = queryClient();
        const view = render(tree(FORKS, false, client));

        await user.click(screen.getByRole("button", { name: "Fork here" }));
        await screen.findByText(WARNING);

        // The agent restarts while the confirmation is open.
        view.rerender(tree(FORKS, true, client));

        const confirmButton = screen.getAllByRole("button", { name: "Fork here" }).at(-1) as HTMLButtonElement;

        expect(confirmButton.disabled).toBe(true);
        await user.click(confirmButton);
        expect(harness.calls).toEqual([]);
        // Cancel still works.
        expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("keeps the dialog open and the id, and says so as an error, when the answer names no chat", async () => {
        const user = userEvent.setup();

        harness.result = { started: false };
        mount(FORKS);
        await user.click(screen.getByRole("button", { name: "Fork here" }));
        await screen.findByText(WARNING);
        await user.click(screen.getAllByRole("button", { name: "Fork here" }).at(-1)!);
        await waitFor(() => expect(harness.toasts).toEqual(["This fork is still being made. Try again in a moment."]));
        expect(screen.getByText("Fork this chat?")).toBeTruthy();
        expect(harness.navigated).toEqual([]);

        // The same click, again in a moment: the same id, and now the chat.
        harness.result = undefined;
        await user.click(screen.getAllByRole("button", { name: "Fork here" }).at(-1)!);
        await waitFor(() => expect(harness.calls).toHaveLength(2));

        const [first, second] = harness.calls as { clientId: string }[];

        expect(second?.clientId).toBe(first?.clientId);
        await waitFor(() => expect(harness.navigated).toHaveLength(1));
    });

    it("is off while the agent is still starting", () => {
        mount(FORKS, true);

        expect((screen.getByRole("button", { name: "Fork here" }) as HTMLButtonElement).disabled).toBe(true);
    });
});
