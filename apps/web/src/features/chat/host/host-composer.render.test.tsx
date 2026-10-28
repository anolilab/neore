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
        /** What the next sends answer, in order; an empty list answers ok. */
        sendResults: [] as ({ error: string; ok: false } | { ok: true })[],
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

            return harness.sendResults.shift() ?? { ok: true };
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
                            return {
                                queryFn:
                                    args === skipToken
                                        ? skipToken
                                        : async () => harness.data[path.join(".")] ?? (path.at(-1) === "getHostPendingPermissions" ? [] : null),
                                queryKey: [path.join("."), args],
                            };
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
const CUT = /too long to show whole/u;

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
    harness.sendResults = [];
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

    it("reuses the request id for a retry of the same text and takes a new one for different text", async () => {
        harness.sendResults = [
            { error: "unreachable", ok: false },
            { error: "unreachable", ok: false },
        ];
        mount(session());

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;
        const send = () => fireEvent.click(screen.getByRole("button", { name: "Send" }));

        fireEvent.change(box, { target: { value: "first" } });
        send();
        await waitFor(() => expect(harness.calls).toHaveLength(1));
        // The answer was lost: the same text goes again under the same id.
        await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false));
        send();
        await waitFor(() => expect(harness.calls).toHaveLength(2));
        // An edit is another message.
        fireEvent.change(box, { target: { value: "second" } });
        await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false));
        send();
        await waitFor(() => expect(harness.calls).toHaveLength(3));

        const ids = harness.calls.map(([, input]) => (input as { requestId: string }).requestId);

        expect(ids[1]).toBe(ids[0]);
        expect(ids[2]).not.toBe(ids[0]);
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

    it("says the agent is starting and still takes a message, which goes out once it is up", async () => {
        mount(session({ status: "starting" }));

        expect(await screen.findByText("Starting the agent on your computer. A message you send now goes out once it is up.")).toBeTruthy();
        expect((screen.getByLabelText("Message to the coding agent") as HTMLTextAreaElement).disabled).toBe(false);
    });

    it("takes no message once the session has ended", async () => {
        mount(session({ status: "ended" }));

        expect(await screen.findByText("This session has ended. Start a new one from the desktop app.")).toBeTruthy();
        expect((screen.getByLabelText("Message to the coding agent") as HTMLTextAreaElement).disabled).toBe(true);
    });

    it("offers Continue after a restart or a timeout, and sends it as a message", async () => {
        mount(session({ lastEndReason: "interrupted" }));

        fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

        await waitFor(() =>
            expect(harness.calls[0]).toEqual(["send", { requestId: expect.any(String), text: "Continue where you left off.", threadId: "thread-1" }]),
        );
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

    it("says a request was cut and offers only a decline", async () => {
        mount({
            ...withRequest(),
            "acp.remote.getHostPendingPermissions": [{ command: "pnpm te", incomplete: true, options: [OPTIONS[1]], requestId: "r1", tool: "Run tests" }],
        });

        expect(await screen.findByText(CUT)).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
        expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
    });

    it("answers with the agent's own option id for that request", async () => {
        mount(withRequest());

        fireEvent.click(await screen.findByRole("button", { name: "Allow once" }));

        await waitFor(() =>
            expect(harness.calls).toContainEqual(["acp.remote.answerHostPermission", { optionId: "r1-allow", requestId: "r1", threadId: "thread-1" }]),
        );
    });

    it("declines with the agent's reject option", async () => {
        mount(withRequest());

        fireEvent.click(await screen.findByRole("button", { name: "Decline" }));

        await waitFor(() =>
            expect(harness.calls).toContainEqual(["acp.remote.answerHostPermission", { optionId: "r1-reject", requestId: "r1", threadId: "thread-1" }]),
        );
    });
});
