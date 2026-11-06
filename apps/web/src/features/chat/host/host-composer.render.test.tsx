/**
 * The composer of a coding agent's thread: what it offers in each state of the session and the turn, and that the
 * permission buttons send only an option the agent offered (allow once, decline), by the ids the backend gave.
 */

import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
            return { i18n: { locale: "en" }, t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
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
const STILL_SHOWS_FAST = /The agent confirmed Deep, but Model still shows Fast/u;

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

// The text is on screen for the person: it is in the document, and no ancestor hides it with `hidden` or `aria-hidden`. jsdom does not
// apply the stylesheet, so a class that hides it is not seen here.
const expectShown = (element: HTMLElement) => {
    expect(element.isConnected).toBe(true);
    // The ancestor check needs the node itself: no query finds a hidden ancestor.
    // eslint-disable-next-line testing-library/no-node-access -- checks the hiding attributes of the ancestors, which no query does
    expect(element.closest("[hidden], [aria-hidden='true']")).toBeNull();
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

const WINDOW_TEXT = /\/200K/u;
const METER_NAME = /12K\/200K tokens used/u;

describe("what the agent reports about itself", () => {
    it("shows the context the agent reported, against its window", async () => {
        mount(session({ agentState: { usage: { size: 200_000, used: 12_345 } } }));

        expect(await screen.findByText("12K/200K")).toBeTruthy();
    });

    it("shows no meter until the agent has reported its usage", async () => {
        mount(session());

        await screen.findByLabelText("Message to the coding agent");
        expect(screen.queryByText(WINDOW_TEXT)).toBeNull();
    });

    it("shows a reported cost whose currency code is not valid, as the bare number, in the meter's tooltip", async () => {
        mount(session({ agentState: { usage: { cost: { amount: 0.5, currency: "not money!" }, size: 200_000, used: 12_345 } } }));

        // The tooltip positions itself with ResizeObserver, which the shared stub (a function, not a class) cannot be constructed as.
        // The stub only has to be constructible; its methods do nothing and need no receiver.
        /* eslint-disable class-methods-use-this */
        vi.stubGlobal(
            "ResizeObserver",
            class {
                disconnect() {}

                observe() {}

                unobserve() {}
            },
        );
        /* eslint-enable class-methods-use-this */

        try {
            const meter = await screen.findByRole("button", { name: METER_NAME });

            fireEvent.focus(meter);

            expect(await screen.findByText("Cost reported by the agent: 0.5 not money!")).toBeTruthy();
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

const WAITING_STATUS = /^Waiting/u;

describe("the options the agent offers", () => {
    const MODEL = {
        category: "model",
        choices: [
            { name: "Fast", value: "fast" },
            { name: "Deep", value: "deep" },
        ],
        currentValue: "fast",
        id: "model",
        name: "Model",
    };
    const EFFORT = {
        category: "thought_level",
        choices: [
            { name: "Low", value: "low" },
            { name: "High", value: "high" },
        ],
        currentValue: "high",
        id: "effort",
        name: "Reasoning effort",
    };

    const mountWith = (fields: Record<string, unknown>, result?: unknown) => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        harness.data = { ...session(fields), ...(result !== undefined && { "acp.remote.setHostOption:result": result }) };
        render(
            <QueryClientProvider client={client}>
                <HostComposer threadId="thread-1" />
            </QueryClientProvider>,
        );

        return client;
    };

    const mutations = () => harness.calls.filter(([name]) => name === "acp.remote.setHostOption");

    it("shows each option with its current value under a name, and nothing when the agent reported none", async () => {
        mountWith({ agentState: { configOptions: [MODEL, EFFORT] } });

        expect(((await screen.findByLabelText("Model")) as unknown as HTMLSelectElement).value).toBe("fast");
        expect((screen.getByLabelText("Reasoning effort") as unknown as HTMLSelectElement).value).toBe("high");
        expect(screen.getByRole("list", { name: "Agent options" })).toBeTruthy();
    });

    it("shows a mode option read-only whatever the case of its category, since the computer refuses to change it", async () => {
        const MODE = {
            category: "Mode",
            choices: [
                { name: "Ask", value: "ask" },
                { name: "Code", value: "code" },
            ],
            currentValue: "ask",
            id: "mode",
            name: "Mode",
        };

        mountWith({ agentState: { configOptions: [MODE] } });

        await screen.findByRole("list", { name: "Agent options" });
        expect(screen.queryByLabelText("Mode")).toBeNull();
        expect(screen.getByText("Ask")).toBeTruthy();
    });

    it("keeps the answer to this page's change when another client's result replaces the session's one, and does not wait again", async () => {
        const client = mountWith({ _id: "session-1", agentState: { configOptions: [MODEL] } }, { callId: "call-1", sent: true });
        const model = (await screen.findByLabelText("Model")) as unknown as HTMLSelectElement;

        fireEvent.change(model, { target: { value: "deep" } });
        await waitFor(() => expect(mutations()).toHaveLength(1));

        const key = ["acp.functions.getHostSession", { threadId: "thread-1" }];

        client.setQueryData(key, {
            _id: "session-1",
            agentState: { configOptions: [{ ...MODEL, currentValue: "deep" }] },
            optionResult: { callId: "call-1", optionId: "model", outcome: "confirmed", valueId: "deep" },
            status: "idle",
        });
        await screen.findByText("The agent confirmed: Model is now Deep.");

        // Another client then changes the option: the session's one result is theirs now, and this page's answer must stand.
        client.setQueryData(key, {
            _id: "session-1",
            agentState: { configOptions: [{ ...MODEL, currentValue: "fast" }] },
            optionResult: { callId: "call-2", optionId: "model", outcome: "refused", reason: "the agent did not accept the change", valueId: "fast" },
            status: "idle",
        });

        await waitFor(() => expect((screen.getByLabelText("Model") as unknown as HTMLSelectElement).disabled).toBe(false));
        expect(screen.queryByText(WAITING_STATUS)).toBeNull();
    });

    it("names the option in its refusal, and while it waits, when the agent has removed the option since the change", async () => {
        const client = mountWith({ _id: "session-1", agentState: { configOptions: [MODEL] } }, { callId: "call-1", sent: true });
        const model = (await screen.findByLabelText("Model")) as unknown as HTMLSelectElement;

        fireEvent.change(model, { target: { value: "deep" } });
        await waitFor(() => expect(mutations()).toHaveLength(1));

        // Still waiting for its answer when the agent's list loses the option.
        client.setQueryData(["acp.functions.getHostSession", { threadId: "thread-1" }], {
            _id: "session-1",
            agentState: { configOptions: [] },
            status: "idle",
        });
        expect(await screen.findByText("Waiting for the agent to change Model to Deep.")).toBeTruthy();

        client.setQueryData(["acp.functions.getHostSession", { threadId: "thread-1" }], {
            _id: "session-1",
            agentState: { configOptions: [] },
            optionResult: { callId: "call-1", optionId: "model", outcome: "refused", reason: "the agent did not accept the change", valueId: "deep" },
            status: "idle",
        });
        expect(await screen.findByText("The agent did not change Model: the agent did not accept the change")).toBeTruthy();
    });

    it("says what the agent confirmed when the option it changed is no longer among its options", async () => {
        const client = mountWith({ _id: "session-1", agentState: { configOptions: [MODEL] } }, { callId: "call-1", sent: true });
        const model = (await screen.findByLabelText("Model")) as unknown as HTMLSelectElement;

        fireEvent.change(model, { target: { value: "deep" } });
        await waitFor(() => expect(mutations()).toHaveLength(1));

        // The agent's list no longer has the model, and the session holds its confirmed answer for that change.
        client.setQueryData(["acp.functions.getHostSession", { threadId: "thread-1" }], {
            _id: "session-1",
            agentState: { configOptions: [] },
            optionResult: { callId: "call-1", optionId: "model", outcome: "confirmed", valueId: "deep" },
            status: "idle",
        });

        expect(await screen.findByText("The agent confirmed: Model is now Deep, but no longer lists Model.")).toBeTruthy();
    });

    it("gives a new session in the thread its own options, not the change still waiting on the old session", async () => {
        const client = mountWith({ _id: "session-1", agentState: { configOptions: [MODEL] } }, { callId: "call-1", sent: true });
        const model = (await screen.findByLabelText("Model")) as unknown as HTMLSelectElement;

        fireEvent.change(model, { target: { value: "deep" } });
        await waitFor(() => expect(model.disabled).toBe(true));

        // The thread's newest session is another one: the old session's answer never comes, so its wait must not carry over.
        client.setQueryData(["acp.functions.getHostSession", { threadId: "thread-1" }], {
            _id: "session-2",
            agentState: { configOptions: [MODEL] },
            status: "idle",
        });

        await waitFor(() => expect((screen.getByLabelText("Model") as unknown as HTMLSelectElement).disabled).toBe(false));
    });

    it("hands a change to the client while the browser is offline, so the client can queue it", async () => {
        mountWith({ agentState: { configOptions: [MODEL, EFFORT] } }, { callId: "call-1", sent: true });

        const model = (await screen.findByLabelText("Model")) as unknown as HTMLSelectElement;

        onlineManager.setOnline(false);

        try {
            fireEvent.change(model, { target: { value: "deep" } });

            // The mutation is not paused by the offline state: the client receives it, and queues it.
            await waitFor(() => expect(mutations()).toHaveLength(1));
        } finally {
            onlineManager.setOnline(true);
        }
    });

    it("renders no options row for an agent that reported none", async () => {
        mountWith({});

        await screen.findByLabelText("Message to the coding agent");
        expect(screen.queryByRole("list", { name: "Agent options" })).toBeNull();
    });

    it("queues the chosen value for the option and keeps every control off until the agent has answered", async () => {
        mountWith({ agentState: { configOptions: [MODEL, EFFORT] } }, { callId: "call-1", sent: true });

        const model = (await screen.findByLabelText("Model")) as unknown as HTMLSelectElement;

        fireEvent.change(model, { target: { value: "deep" } });

        await waitFor(() => expect(mutations()).toHaveLength(1));
        expect(mutations()[0]?.[1]).toEqual({ optionId: "model", threadId: "thread-1", valueId: "deep" });
        await waitFor(() => expect(model.disabled).toBe(true));
        expect((screen.getByLabelText("Reasoning effort") as unknown as HTMLSelectElement).disabled).toBe(true);
        expectShown(screen.getByText("Waiting for the agent to change Model to Deep."));
    });

    it("says in words that the agent confirmed the change, and frees the controls", async () => {
        const client = mountWith({ agentState: { configOptions: [MODEL] } }, { callId: "call-1", sent: true });
        const model = (await screen.findByLabelText("Model")) as unknown as HTMLSelectElement;

        fireEvent.change(model, { target: { value: "deep" } });
        await waitFor(() => expect(model.disabled).toBe(true));

        harness.data = {
            ...harness.data,
            "acp.functions.getHostSession": {
                agentState: { configOptions: [{ ...MODEL, currentValue: "deep" }] },
                optionResult: { callId: "call-1", optionId: "model", outcome: "confirmed", valueId: "deep" },
                status: "idle",
            },
        };
        await client.invalidateQueries();

        expectShown(await screen.findByText("The agent confirmed: Model is now Deep."));
        expect(model.disabled).toBe(false);
        expect(model.value).toBe("deep");
    });

    it("does not say confirmed over the old value: it waits for the option to show the new one", async () => {
        const client = mountWith({ agentState: { configOptions: [MODEL] } }, { callId: "call-1", sent: true });
        const model = (await screen.findByLabelText("Model")) as unknown as HTMLSelectElement;

        fireEvent.change(model, { target: { value: "deep" } });
        await waitFor(() => expect(model.disabled).toBe(true));

        // The agent's answer is in, but the options it changed have not arrived yet.
        harness.data = {
            ...harness.data,
            "acp.functions.getHostSession": {
                agentState: { configOptions: [MODEL] },
                optionResult: { callId: "call-1", optionId: "model", outcome: "confirmed", valueId: "deep" },
                status: "idle",
            },
        };
        await client.invalidateQueries();

        expectShown(await screen.findByText("The agent confirmed. Waiting for Model to show Deep."));
        expect(screen.queryByText("The agent confirmed: Model is now Deep.")).toBeNull();
        expect(model.disabled).toBe(true);

        harness.data = {
            ...harness.data,
            "acp.functions.getHostSession": {
                agentState: { configOptions: [{ ...MODEL, currentValue: "deep" }] },
                optionResult: { callId: "call-1", optionId: "model", outcome: "confirmed", valueId: "deep" },
                status: "idle",
            },
        };
        await client.invalidateQueries();

        expectShown(await screen.findByText("The agent confirmed: Model is now Deep."));
        expect(model.disabled).toBe(false);
    });

    it("says the agent answered late when its answer comes after the wait, and the option shows the value it gave", async () => {
        const client = mountWith({ agentState: { configOptions: [MODEL] } }, { callId: "call-1", sent: true });
        const model = (await screen.findByLabelText("Model")) as unknown as HTMLSelectElement;

        fireEvent.change(model, { target: { value: "deep" } });
        await waitFor(() => expect(model.disabled).toBe(true));

        // The page's call failed at the agent's timeout, and the agent's late answer has since changed the option.
        harness.data = {
            ...harness.data,
            "acp.functions.getHostSession": {
                agentState: { configOptions: [{ ...MODEL, currentValue: "deep" }] },
                optionResult: { callId: "call-1", optionId: "model", outcome: "refused", reason: "the agent did not answer", valueId: "deep" },
                status: "idle",
            },
        };
        await client.invalidateQueries();

        expectShown(await screen.findByText("The agent answered late: Model is now Deep."));
        expect(screen.queryByText("The agent did not change Model: the agent did not answer")).toBeNull();
    }, 30_000);

    it("says the option has not caught up when the agent confirmed a value it still does not show, and then frees the control", async () => {
        const client = mountWith({ agentState: { configOptions: [MODEL] } }, { callId: "call-1", sent: true });
        const model = (await screen.findByLabelText("Model")) as unknown as HTMLSelectElement;

        fireEvent.change(model, { target: { value: "deep" } });
        await waitFor(() => expect(model.disabled).toBe(true));

        // The agent confirmed the value, but the options it reports keep the old one past the page's wait.
        harness.data = {
            ...harness.data,
            "acp.functions.getHostSession": {
                agentState: { configOptions: [MODEL] },
                optionResult: { callId: "call-1", optionId: "model", outcome: "confirmed", valueId: "deep" },
                status: "idle",
            },
        };
        await client.invalidateQueries();

        expectShown(await screen.findByText(STILL_SHOWS_FAST, undefined, { timeout: 25_000 }));
        expect(screen.queryByText("The agent confirmed: Model is now Deep.")).toBeNull();
        expect(model.disabled).toBe(false);
    }, 40_000);

    it("says why the agent refused, and leaves the value as it was", async () => {
        const client = mountWith({ agentState: { configOptions: [MODEL] } }, { callId: "call-1", sent: true });
        const model = (await screen.findByLabelText("Model")) as unknown as HTMLSelectElement;

        fireEvent.change(model, { target: { value: "deep" } });
        await waitFor(() => expect(model.disabled).toBe(true));

        harness.data = {
            ...harness.data,
            "acp.functions.getHostSession": {
                agentState: { configOptions: [MODEL] },
                optionResult: { callId: "call-1", optionId: "model", outcome: "refused", reason: "the agent did not accept the change", valueId: "deep" },
                status: "idle",
            },
        };
        await client.invalidateQueries();

        expectShown(await screen.findByText("The agent did not change Model: the agent did not accept the change"));
        expect(model.disabled).toBe(false);
        expect(model.value).toBe("fast");
    });

    it("tells the person when the change was not sent, with the reason, and frees the control", async () => {
        mountWith({ agentState: { configOptions: [MODEL] } }, { reason: "offline", sent: false });

        const model = (await screen.findByLabelText("Model")) as unknown as HTMLSelectElement;

        fireEvent.change(model, { target: { value: "deep" } });

        expect(await screen.findByText("Your computer is offline. Open Neore on it and try again.")).toBeTruthy();
        expect(model.disabled).toBe(false);
    });

    it("shows the legacy model and mode states without a way to change them: a mode is changed on the computer", async () => {
        mountWith({
            agentState: {
                modes: {
                    available: [
                        { id: "ask", name: "Ask" },
                        { id: "code", name: "Code" },
                    ],
                    current: "ask",
                },
                models: { available: [{ id: "m1", name: "M1" }], current: "m1" },
            },
        });

        expect(await screen.findByText("M1")).toBeTruthy();
        expect(screen.queryByLabelText("Model")).toBeNull();
        expect(screen.queryByLabelText("Mode")).toBeNull();
        expect(screen.getByText("Ask")).toBeTruthy();
        expect(mutations()).toHaveLength(0);
    });

    it("keeps the controls off once the session has ended", async () => {
        mountWith({ agentState: { configOptions: [MODEL] }, status: "ended" });

        expect(((await screen.findByLabelText("Model")) as unknown as HTMLSelectElement).disabled).toBe(true);
    });
});
