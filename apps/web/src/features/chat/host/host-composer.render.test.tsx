/**
 * The composer of a coding agent's thread: what it offers in each state of the session and the turn, and that the
 * permission buttons send only an option the agent offered (allow once, decline), by the ids the backend gave.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    return {
        calls: [] as [string, unknown][],
        data: {} as Record<string, unknown>,
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        Trans: ({ children }: { children: unknown }) => children,
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("sonner", () => {
    return { toast: { error: vi.fn(), success: vi.fn() } };
});

vi.mock("./host-send", () => {
    return {
        MAX_HOST_PROMPT_CHARS: 30_000,
        sendHostMessage: vi.fn(async (input: unknown) => {
            harness.calls.push(["send", input]);

            return { ok: true };
        }),
    };
});

vi.mock("@/lib/lunora/crpc", async () => {
    const { skipToken } = await import("@tanstack/react-query");
    const node = (path: string[]): object =>
        new Proxy(
            {},
            {
                get: (_target, key) => {
                    const here = [...path, String(key)].join(".");

                    if (key === "queryOptions") {
                        return (args: unknown) => {
                            return { queryFn: args === skipToken ? skipToken : async () => harness.data[path.join(".")] ?? (path.at(-1) === "getHostPendingPermissions" ? [] : null), queryKey: [path.join("."), args] };
                        };
                    }

                    if (key === "mutationOptions") {
                        return () => {
                            return {
                                mutationFn: async (args: unknown) => {
                                    harness.calls.push([path.join("."), args]);

                                    return harness.data[`${path.join(".")}:result`] ?? { sent: true };
                                },
                            };
                        };
                    }

                    return node([...path, String(key)]) ?? here;
                },
            },
        );

    return { useCRPC: () => node([]) };
});

const { default: HostComposer } = await import("./host-composer");

const ALWAYS = /always/iu;

const OPTIONS = [
    { kind: "allow_once", name: "Allow", optionId: "r1-allow" },
    { kind: "reject_once", name: "Reject", optionId: "r1-reject" },
];

const mount = (data: Record<string, unknown>) => {
    harness.data = data;

    render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <HostComposer threadId="thread-1" />
        </QueryClientProvider>,
    );
};

const session = (fields: Record<string, unknown> = {}) => {
    return { "acp.functions.getHostSession": { status: "idle", ...fields } };
};

beforeEach(() => {
    harness.calls = [];
});

afterEach(() => {
    harness.data = {};
});

describe("the coding-agent composer", () => {
    it("sends the message under one request id and clears the box", async () => {
        mount(session());

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "  fix the bug  " } });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));

        await waitFor(() => expect(harness.calls).toHaveLength(1));
        expect(harness.calls[0]).toEqual(["send", { requestId: expect.any(String), text: "fix the bug", threadId: "thread-1" }]);
        await waitFor(() => expect(box.value).toBe(""));
    });

    it("does not send an empty message", async () => {
        mount(session());

        await screen.findByLabelText("Message to the coding agent");
        expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("offers Stop instead of Send while a turn runs, and stops that thread", async () => {
        mount({ ...session(), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        fireEvent.click(await screen.findByRole("button", { name: "Stop" }));

        await waitFor(() => expect(harness.calls).toContainEqual(["acp.remote.cancelHostTurn", { threadId: "thread-1" }]));
        expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    });

    it("says the agent is starting and takes no message until it has started", async () => {
        mount(session({ status: "starting" }));

        expect(await screen.findByText("Starting the agent on your computer…")).toBeTruthy();
        expect((screen.getByLabelText("Message to the coding agent") as HTMLTextAreaElement).disabled).toBe(true);
    });

    it("takes no message once the session has ended", async () => {
        mount(session({ status: "ended" }));

        expect(await screen.findByText("This session has ended. Start a new one from the desktop app.")).toBeTruthy();
        expect((screen.getByLabelText("Message to the coding agent") as HTMLTextAreaElement).disabled).toBe(true);
    });

    it("offers Continue after a restart or a timeout, and sends it as a message", async () => {
        mount(session({ lastEndReason: "interrupted" }));

        fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

        await waitFor(() => expect(harness.calls[0]).toEqual(["send", { requestId: expect.any(String), text: "Continue where you left off.", threadId: "thread-1" }]));
    });

    it("offers no Continue after a turn that finished or was stopped", async () => {
        mount(session({ lastEndReason: "finished" }));

        await screen.findByLabelText("Message to the coding agent");
        expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    });
});

describe("a permission request from the agent", () => {
    const withRequest = () => {
        return {
            ...session(),
            "acp.remote.getHostPendingPermissions": [{ command: "pnpm test", options: OPTIONS, requestId: "r1", target: "src/a.ts", tool: "Run tests" }],
            "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" },
        };
    };

    it("shows the tool, target and command in full, and only allow once and decline", async () => {
        mount(withRequest());

        expect(await screen.findByText("Run tests")).toBeTruthy();
        expect(screen.getByText("src/a.ts")).toBeTruthy();
        expect(screen.getByText("pnpm test")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
        expect(screen.queryByText(ALWAYS)).toBeNull();
    });

    it("answers with the agent's own option id for that request", async () => {
        mount(withRequest());

        fireEvent.click(await screen.findByRole("button", { name: "Allow once" }));

        await waitFor(() => expect(harness.calls).toContainEqual(["acp.remote.answerHostPermission", { optionId: "r1-allow", requestId: "r1", threadId: "thread-1" }]));
    });

    it("declines with the agent's reject option", async () => {
        mount(withRequest());

        fireEvent.click(await screen.findByRole("button", { name: "Decline" }));

        await waitFor(() => expect(harness.calls).toContainEqual(["acp.remote.answerHostPermission", { optionId: "r1-reject", requestId: "r1", threadId: "thread-1" }]));
    });
});
