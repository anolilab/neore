/**
 * The composer of a coding agent's thread: what it offers in each state of the session and the turn, and that the
 * permission buttons send only an option the agent offered (allow once, decline), by the ids the backend gave.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { focusNextArea } from "@/features/keyboard/lib/focus-areas";

const NAME_0 = /^(Send|Queue)$/;

const harness = vi.hoisted(() => {
    return {
        calls: [] as [string, unknown][],
        /** What the next sends answer, in order; an empty list answers ok. */
        sendResults: [] as ({ error: string; ok: false } | { ok: true })[],
        /** When set, a send waits for it before it answers. */
        gate: undefined as Promise<void> | undefined,
        data: {} as Record<string, unknown>,
        /** The client of the mounted composer, so a test can end the turn it started. */
        client: undefined as QueryClient | undefined,
        /** Runs when a send is made, before its answer, so a test can change the queue while that send is in flight. */
        onSend: undefined as (() => void) | undefined,
        /** Query keys that wait on `gate` before answering, so a test can mount while they are still loading. */
        hold: [] as string[],
        /** Query keys whose reads fail, so a test can see what the composer does when a read is refused. */
        fail: [] as string[],
        /** Holds every send's answer until a test releases it, so a test can end a turn while a send is in flight. */
        sendGate: undefined as Promise<void> | undefined,
        /** Holds the stop's answer until a test releases it, so a test can change the queue while the stop is in flight. */
        cancelGate: undefined as Promise<void> | undefined,
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
    return { toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } };
});

vi.mock("./host-send", () => {
    return {
        MAX_HOST_PROMPT_CHARS: 30_000,
        sendHostMessage: vi.fn(async (input: unknown) => {
            harness.calls.push(["send", input]);
            // The answer belongs to this call, taken when it is made: a send still in flight when its test ends must not take
            // the answer the next test scripted.
            const answer = harness.sendResults.shift() ?? { ok: true };

            harness.onSend?.();

            if (harness.sendGate !== undefined) {
                await harness.sendGate;
            }

            if (harness.gate) {
                await harness.gate;
            }

            return answer;
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
                                        : async () => {
                                              if (harness.fail.includes(path.join("."))) {
                                                  throw new Error("read failed");
                                              }

                                              if (harness.hold.includes(path.join("."))) {
                                                  await harness.gate;
                                              }

                                              return harness.data[path.join(".")] ?? (path.at(-1) === "getHostPendingPermissions" ? [] : null);
                                          },
                                queryKey: [path.join("."), args],
                            };
                        };
                    }

                    if (key === "mutationOptions") {
                        return () => {
                            return {
                                mutationFn: async (args: unknown) => {
                                    harness.calls.push([path.join("."), args]);

                                    if (path.join(".") === "acp.remote.cancelHostTurn" && harness.cancelGate !== undefined) {
                                        await harness.cancelGate;
                                    }

                                    const failure = harness.data[`${path.join(".")}:error`];

                                    if (failure !== undefined) {
                                        throw failure;
                                    }

                                    const fallback = path.join(".") === "acp.remote.cancelHostTurn" ? { cancelled: true } : { sent: true };

                                    return harness.data[`${path.join(".")}:result`] ?? fallback;
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
const { usePromptQueueStore } = await import("@/features/chat/core/stores/prompt-queue-store");

const ALWAYS = /always/iu;
const EDIT_BUTTON = /Edit queued message \d/u;
const SEND_OR_QUEUE = /^(Send|Queue)$/u;
const CUT = /too long to show whole/u;

const OPTIONS = [
    { kind: "allow_once", name: "Allow", optionId: "r1-allow" },
    { kind: "reject_once", name: "Reject", optionId: "r1-reject" },
];

const mount = (data: Record<string, unknown>) => {
    harness.data = data;
    harness.client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    return render(
        <QueryClientProvider client={harness.client}>
            <HostComposer threadId="thread-1" />
        </QueryClientProvider>,
    );
};

const sendCalls = () => harness.calls.filter(([name]: [string, unknown]) => name === "send");

/**
 * A promise a test releases by hand. The resolver is explicit because the configured Node range (22.0) predates
 * `Promise.withResolvers`.
 */
const gate = (): { promise: Promise<void>; release: () => void } => {
    let release: () => void = () => undefined;
    // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });

    return { promise, release };
};

/**
 * Ends the stream the test set up: the next read of it finds no turn running, as after the agent finishes. The session
 * reports the end as the backend does, by the stream that ended (the running one, or a fresh one for a turn the test never
 * showed running) and its reason.
 */
const endTurn = async (lastEndReason = "finished") => {
    const running = harness.data["chat.streaming.getActiveStreamForThread"] as { streamId?: string } | null | undefined;

    harness.data = {
        ...harness.data,
        "acp.functions.getHostSession": {
            lastEndedReason: lastEndReason,
            lastEndReason,
            lastEndStreamId: running?.streamId ?? `ended-${harness.calls.length}-${Math.random().toString(36).slice(2)}`,
            status: "idle",
        },
        "chat.streaming.getActiveStreamForThread": null,
    };
    await harness.client?.invalidateQueries();
};

/** A session read. A last end reason given alone is the end of an earlier stream, as the backend reports it with no turn live. */
const session = (fields: Record<string, unknown> = {}) => {
    const ended =
        typeof fields.lastEndReason === "string" && fields.lastEndStreamId === undefined
            ? { lastEndedReason: fields.lastEndReason, lastEndStreamId: "stream-before" }
            : {};

    return { "acp.functions.getHostSession": { status: "idle", ...ended, ...fields } };
};

beforeEach(() => {
    harness.calls = [];
    harness.sendResults = [];
    harness.hold = [];
    harness.gate = undefined;
    harness.fail = [];
    harness.sendGate = undefined;
    harness.cancelGate = undefined;
    harness.onSend = undefined;
    usePromptQueueStore.setState({ queues: {} });
    globalThis.sessionStorage?.clear();
});

afterEach(() => {
    harness.data = {};
});

describe("the coding-agent composer", () => {
    it("is a focus area for F6, as the cloud composer is, so F6 reaches it", async () => {
        mount(session());

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        expect(box.dataset.focusArea).toBe("composer");

        // jsdom does no layout: the box is given one, as it has on the page, so F6 can count it as shown.
        Object.assign(box, {
            getBoundingClientRect: () => {
                return { bottom: 40, height: 40, left: 0, right: 300, top: 0, width: 300 };
            },
            getClientRects: () => [{}],
        });

        expect(focusNextArea(1)).toBe(true);
        // eslint-disable-next-line testing-library/no-node-access -- focus placement is what this asserts
        expect(document.activeElement).toBe(box);
    });

    it("sends the message under one request id and clears the box", async () => {
        mount(session());

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "  fix the bug  " } });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));

        await waitFor(() => expect(harness.calls).toHaveLength(1));
        expect(harness.calls[0]).toEqual(["send", { requestId: expect.any(String), text: "fix the bug", threadId: "thread-1" }]);
        await waitFor(() => expect(box.value).toBe(""));
    });

    it("clears the box after a send whose text had a hidden character, so the message is not sent again", async () => {
        mount(session());

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "fix​the bug" } });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));

        await waitFor(() => expect(harness.calls).toHaveLength(1));
        expect(harness.calls[0]).toEqual(["send", { requestId: expect.any(String), text: "fixthe bug", threadId: "thread-1" }]);
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
        await waitFor(() => expect((screen.getByRole("button", { name: NAME_0 }) as HTMLButtonElement).disabled).toBe(false));
        send();
        await waitFor(() => expect(harness.calls).toHaveLength(2));
        // An edit is another message.
        fireEvent.change(box, { target: { value: "second" } });
        await waitFor(() => expect((screen.getByRole("button", { name: NAME_0 }) as HTMLButtonElement).disabled).toBe(false));
        send();
        await waitFor(() => expect(harness.calls).toHaveLength(3));

        const ids = harness.calls.map(([, input]) => (input as { requestId: string }).requestId);

        expect(ids[1]).toBe(ids[0]);
        expect(ids[2]).not.toBe(ids[0]);
    });

    it("counts the length the server will send, so a draft ending in a joiner that is removed is not refused", async () => {
        mount(session());

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;
        // 29,998 characters, an emoji (two units) and a trailing joiner: 30,001 units while typed, 30,000 once the joiner goes.
        const draft = `${"a".repeat(29_998)}\u{1F600}\u{200D}`;

        fireEvent.change(box, { target: { value: draft } });

        const send = screen.getByRole("button", { name: NAME_0 }) as HTMLButtonElement;

        expect(send.disabled).toBe(false);
        fireEvent.click(send);
        await waitFor(() => expect(harness.calls).toHaveLength(1));
        expect((harness.calls[0]?.[1] as { text: string }).text).toBe(`${"a".repeat(29_998)}\u{1F600}`);
        // The sent text clears from the box, joiner and all.
        await waitFor(() => expect(box.value).toBe(""));
    });

    it("keeps the refusal of a paste made while a send is in flight, and keeps Send off for the draft", async () => {
        let open: () => void = () => undefined;

        harness.gate = new Promise<void>((resolve) => {
            open = () => {
                resolve();
            };
        });

        mount(session());

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "a valid draft" } });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        await waitFor(() => expect(harness.calls).toHaveLength(1));

        // A paste is refused while the first send is still pending.
        fireEvent.change(box, { target: { value: "x".repeat(120_001) } });
        open();
        harness.gate = undefined;

        await waitFor(() => expect(box.value).toBe(""));
        // The refusal made during the send is still shown, and the field cannot send.
        expect(screen.queryAllByRole("status").length).toBeGreaterThan(0);
        expect((screen.getByRole("button", { name: NAME_0 }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("keeps a joiner typed while a send is pending, and does not clear the draft it did not send", async () => {
        let open: () => void = () => undefined;

        harness.gate = new Promise<void>((resolve) => {
            open = () => {
                resolve();
            };
        });
        mount(session());

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "x\u{1F600}" } });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        await waitFor(() => expect(harness.calls).toHaveLength(1));

        // The person keeps going while the send is pending: a joiner continues the emoji sequence.
        fireEvent.change(box, { target: { value: "x\u{1F600}\u{200D}" } });
        open();
        harness.gate = undefined;

        // Wait for the send to finish (Send is off while it is pending), then check what the box holds.
        await waitFor(() => expect((screen.getByRole("button", { name: NAME_0 }) as HTMLButtonElement).disabled).toBe(false));
        expect(box.value).toBe("x\u{1F600}\u{200D}");
    });

    it("does not send the draft a refused paste would have left, and shows the refusal", async () => {
        mount(session());

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "a valid draft" } });
        // A paste over the raw-input limit is refused: the field keeps its draft and says so.
        fireEvent.change(box, { target: { value: "x".repeat(120_001) } });

        expect((screen.getByRole("button", { name: NAME_0 }) as HTMLButtonElement).disabled).toBe(true);
        fireEvent.keyDown(box, { key: "Enter" });
        expect(harness.calls).toHaveLength(0);
        // The field keeps its draft, is marked invalid, and says why as its accessible description.
        expect(box.value).toBe("a valid draft");
        expect(box.getAttribute("aria-invalid")).toBe("true");
        expect(box.getAttribute("aria-describedby")).toBe("host-composer-limit");
        expect(screen.getAllByRole("status").map((element) => element.id)).toContain("host-composer-limit");
    });

    it("removes hidden characters typed into the draft, keeps the caret where it was, and says so", async () => {
        mount(session());

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        // A bidi override typed between "a" and "b", with the caret at the end: the field keeps "ab", and the caret
        // stays at the end of the text, one unit left of where the removed character was counted.
        fireEvent.change(box, { target: { value: "a\u{202E}b" } });

        expect(box.value).toBe("ab");
        await waitFor(() => expect(box.selectionStart).toBe(2));
        expect(toast.info).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ id: "host-composer-hidden-text" }));
    });

    it("does not send an empty message", async () => {
        mount(session());

        await screen.findByLabelText("Message to the coding agent");
        expect((screen.getByRole("button", { name: NAME_0 }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("offers Stop instead of Send while a turn runs, and stops that thread", async () => {
        mount({ ...session(), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        fireEvent.click(await screen.findByRole("button", { name: "Stop" }));

        await waitFor(() => expect(harness.calls).toContainEqual(["acp.remote.cancelHostTurn", { threadId: "thread-1" }]));
        expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    });

    it("queues a message typed while a turn runs, and sends nothing until the turn ends", async () => {
        mount({ ...session(), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "then run the tests" } });
        fireEvent.click(screen.getByRole("button", { name: "Queue" }));

        expect(await screen.findByText("then run the tests")).toBeTruthy();
        expect(box.value).toBe("");
        expect(harness.calls.some(([name]) => name === "send")).toBe(false);
    });

    it("interrupts the reply with Interrupt and send, and keeps the text queued first", async () => {
        mount({ ...session(), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "use the other fixture" } });
        fireEvent.click(screen.getByRole("button", { name: "Interrupt and send" }));

        await waitFor(() => expect(harness.calls).toContainEqual(["acp.remote.cancelHostTurn", { streamId: "stream-1", threadId: "thread-1" }]));
        expect(await screen.findByText("use the other fixture")).toBeTruthy();
        // The turn is still running on the stream, so the text waits for it to end rather than going out now.
        expect(harness.calls.some(([name]) => name === "send")).toBe(false);
        await endTurn();

        await waitFor(() => expect(sendCalls()).toHaveLength(1));
        expect(sendCalls()[0]).toEqual(["send", { requestId: expect.any(String), text: "use the other fixture", threadId: "thread-1" }]);
    });

    it("pauses the queue when a stop from another tab ends the reply, so queued messages wait for Send next", async () => {
        mount({ ...session(), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        await screen.findByLabelText("Message to the coding agent");
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "queued behind" });
        await endTurn("stopped");

        expect(await screen.findByRole("button", { name: "Send next" })).toBeTruthy();
        expect(sendCalls()).toHaveLength(0);
    });

    it("pauses the queue on Stop, so the messages behind a stopped reply do not start on their own", async () => {
        mount({ ...session(), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "after the stop" } });
        fireEvent.click(screen.getByRole("button", { name: "Queue" }));
        await screen.findByText("after the stop");
        fireEvent.click(screen.getByRole("button", { name: "Stop" }));

        await waitFor(() => expect(harness.calls).toContainEqual(["acp.remote.cancelHostTurn", { threadId: "thread-1" }]));
        await endTurn();

        expect(await screen.findByRole("button", { name: "Send next" })).toBeTruthy();
        expect(sendCalls()).toHaveLength(0);
    });

    it("sends a queued message once the turn ends, and takes it off the queue", async () => {
        mount({ ...session(), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "then run the tests" } });
        fireEvent.click(screen.getByRole("button", { name: "Queue" }));
        await screen.findByText("then run the tests");
        await endTurn();

        await waitFor(() => expect(sendCalls()).toHaveLength(1));
        expect(sendCalls()[0]).toEqual(["send", { requestId: expect.any(String), text: "then run the tests", threadId: "thread-1" }]);
        await waitFor(() => expect(screen.queryByText("then run the tests")).toBeNull());
    });

    it("retries a refused queued message under the same request id, so a retry starts no second turn", async () => {
        harness.sendResults = [{ error: "unreachable", ok: false }];
        mount({ ...session(), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "then run the tests" } });
        fireEvent.click(screen.getByRole("button", { name: "Queue" }));
        await screen.findByText("then run the tests");
        await endTurn();

        expect(await screen.findByRole("button", { name: "Send next" })).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Send next" }));

        await waitFor(() => expect(sendCalls()).toHaveLength(2));
        const [first, second] = sendCalls().map(([, input]) => (input as { requestId: string }).requestId);

        expect(second).toBe(first);
    });

    it("sends a paused queue's first message alone on Send now, and keeps the rest paused", async () => {
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "first" });
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "second" });
        usePromptQueueStore.getState().setPaused("thread-1", true);
        mount(session());

        const sendNow = await screen.findByRole("button", { name: "Send queued message 1 now" });

        await waitFor(() => expect((sendNow as HTMLButtonElement).disabled).toBe(false));
        fireEvent.click(sendNow);

        await waitFor(() => expect(sendCalls()).toHaveLength(1));
        expect(sendCalls()[0]).toEqual(["send", { requestId: expect.any(String), text: "first", threadId: "thread-1" }]);
        await endTurn();

        expect(await screen.findByRole("button", { name: "Send next" })).toBeTruthy();
        // Another round of reads after the end has been taken in: a drain of the second message would have posted by now.
        await harness.client?.invalidateQueries();
        await waitFor(() => expect(screen.queryByText("first")).toBeNull());
        expect(sendCalls()).toHaveLength(1);
    });

    it("offers no Send now that would stop a turn a queued message's lost send may have started", async () => {
        harness.sendResults = [{ error: "unreachable", ok: false }];
        mount({ ...session(), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        for (const text of ["lost answer", "behind it"]) {
            fireEvent.change(box, { target: { value: text } });
            fireEvent.click(screen.getByRole("button", { name: "Queue" }));
            await screen.findByText(text);
        }

        await endTurn();
        await waitFor(() => expect(sendCalls()).toHaveLength(1));

        // The send's turn shows up after all: stopping it and sending again under the same id would never run the message. Send
        // now on the message behind it would stop that same turn, so it is off too.
        harness.data = { ...harness.data, "chat.streaming.getActiveStreamForThread": { streamId: "stream-2" } };
        await harness.client?.invalidateQueries();

        expect(((await screen.findByRole("button", { name: "Send queued message 1 now" })) as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByRole("button", { name: "Send queued message 2 now" }) as HTMLButtonElement).disabled).toBe(true);
        // Interrupt and send from the box would stop it too: a message typed now queues instead.
        expect(screen.queryByRole("button", { name: "Interrupt and send" })).toBeNull();
    });

    it("offers no Send now while a direct send whose answer was lost may be the turn running", async () => {
        harness.sendResults = [{ error: "unreachable", ok: false }];
        mount(session());

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "lost direct" } });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        await waitFor(() => expect(sendCalls()).toHaveLength(1));

        // Its turn may be the one that shows up now: stopping it for a message queued behind would lose the first text.
        harness.data = { ...harness.data, "chat.streaming.getActiveStreamForThread": { streamId: "stream-9" } };
        await harness.client?.invalidateQueries();
        fireEvent.change(box, { target: { value: "another" } });
        fireEvent.click(await screen.findByRole("button", { name: "Queue" }));
        await screen.findByText("another");

        expect(((await screen.findByRole("button", { name: "Send queued message 1 now" })) as HTMLButtonElement).disabled).toBe(true);
    });

    it("keeps a lost send's mark through a refusal answered before the backend looks for repeats", async () => {
        harness.sendResults = [
            { error: "unreachable", ok: false },
            { error: "not_authenticated", ok: false },
        ];
        mount({ ...session(), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "lost answer" } });
        fireEvent.click(screen.getByRole("button", { name: "Queue" }));
        await screen.findByText("lost answer");
        await endTurn();
        await waitFor(() => expect(sendCalls()).toHaveLength(1));
        fireEvent.click(await screen.findByRole("button", { name: "Send next" }));
        await waitFor(() => expect(sendCalls()).toHaveLength(2));

        // A sign-in refusal says nothing of the first try, whose turn may be this one.
        harness.data = { ...harness.data, "chat.streaming.getActiveStreamForThread": { streamId: "stream-2" } };
        await harness.client?.invalidateQueries();

        expect(((await screen.findByRole("button", { name: "Send queued message 1 now" })) as HTMLButtonElement).disabled).toBe(true);
    });

    it("offers Send now for a queued message the backend refused outright, since its send started nothing", async () => {
        harness.sendResults = [{ error: "busy", ok: false }];
        mount({ ...session(), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "refused" } });
        fireEvent.click(screen.getByRole("button", { name: "Queue" }));
        await screen.findByText("refused");
        await endTurn();
        await waitFor(() => expect(sendCalls()).toHaveLength(1));

        harness.data = { ...harness.data, "chat.streaming.getActiveStreamForThread": { streamId: "stream-2" } };
        await harness.client?.invalidateQueries();

        const sendNow = await screen.findByRole("button", { name: "Send queued message 1 now" });

        await waitFor(() => expect((sendNow as HTMLButtonElement).disabled).toBe(false));
    });

    it("keeps the interrupting text queued and paused when the reply did not stop", async () => {
        mount({ ...session(), "acp.remote.cancelHostTurn:result": { cancelled: false }, "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "use the other fixture" } });
        fireEvent.click(screen.getByRole("button", { name: "Interrupt and send" }));

        expect(await screen.findByRole("button", { name: "Send next" })).toBeTruthy();
        expect(sendCalls()).toHaveLength(0);
    });

    it("releases the interrupting text when no turn was live, since the reply ended on its own", async () => {
        mount({
            ...session(),
            "acp.remote.cancelHostTurn:result": { cancelled: false, reason: "no_turn" },
            "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" },
        });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "after the ending" } });
        fireEvent.click(screen.getByRole("button", { name: "Interrupt and send" }));

        await waitFor(() => expect(harness.calls).toContainEqual(["acp.remote.cancelHostTurn", { streamId: "stream-1", threadId: "thread-1" }]));
        // The stop found no turn live, so the text goes at once, even while the stream read still names the ended turn.
        await waitFor(() => expect(sendCalls()).toHaveLength(1));
        expect(sendCalls()[0]).toEqual(["send", { requestId: expect.any(String), text: "after the ending", threadId: "thread-1" }]);
        expect(screen.queryByRole("button", { name: "Send next" })).toBeNull();
    });

    it("releases the queue behind an interrupt when the failure that paused it came from an earlier turn", async () => {
        mount({
            ...session({ lastEndReason: "failed", lastEndStreamId: "stream-0", lastEndedReason: "failed" }),
            "acp.remote.cancelHostTurn:result": { cancelled: false, reason: "no_turn" },
            "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" },
        });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "behind the interrupt" });
        fireEvent.change(box, { target: { value: "interrupting" } });
        fireEvent.click(screen.getByRole("button", { name: "Interrupt and send" }));

        await waitFor(() => expect(harness.calls.some(([name]) => name === "acp.remote.cancelHostTurn")).toBe(true));

        // The failed turn ended before this stop; the turn it stopped answered "no turn", so nothing is paused for a failure.
        await waitFor(() => expect(usePromptQueueStore.getState().queues["thread-1"]?.paused).toBe(false));
        expect(screen.queryByRole("button", { name: "Send next" })).toBeNull();
    });

    it("keeps the queue paused when the turn fails while its interrupt is in flight and the stop then reads no turn", async () => {
        let open: () => void = () => undefined;

        harness.cancelGate = new Promise<void>((resolve) => {
            open = () => {
                resolve();
            };
        });
        mount({
            ...session(),
            "acp.remote.cancelHostTurn:result": { cancelled: false, reason: "no_turn" },
            "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" },
        });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "behind the interrupt" });
        fireEvent.change(box, { target: { value: "interrupting" } });
        fireEvent.click(screen.getByRole("button", { name: "Interrupt and send" }));
        await waitFor(() => expect(harness.calls.some(([name]) => name === "acp.remote.cancelHostTurn")).toBe(true));

        // The turn fails while the stop is still in flight, and only then does the stop answer that no turn was live.
        harness.data = {
            ...harness.data,
            "acp.functions.getHostSession": { lastEndReason: "failed", lastEndedReason: "failed", lastEndStreamId: "stream-1", status: "idle" },
            "chat.streaming.getActiveStreamForThread": null,
        };
        await harness.client?.invalidateQueries();
        harness.cancelGate = undefined;
        open();

        await waitFor(() => expect(harness.calls.some(([name]) => name === "acp.remote.cancelHostTurn")).toBe(true));
        await new Promise((resolve) => {
            setTimeout(resolve, 50);
        });
        expect(usePromptQueueStore.getState().queues["thread-1"]?.paused).toBe(true);
        // The interrupting text goes; the message behind it waits, and the person is offered Send next for it.
        await waitFor(() => expect(sendCalls()).toHaveLength(1));
        expect(screen.getByText("behind the interrupt")).toBeTruthy();
        expect(await screen.findByRole("button", { name: "Send next" })).toBeTruthy();
        expect(screen.getByText("The queue is paused. Send next to go on with the queued messages.")).toBeTruthy();
    });

    it("keeps the interrupting text queued and paused when the stop was refused", async () => {
        mount({
            ...session(),
            "acp.remote.cancelHostTurn:error": new Error("refused"),
            "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" },
        });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "use the other fixture" } });
        fireEvent.click(screen.getByRole("button", { name: "Interrupt and send" }));

        expect(await screen.findByRole("button", { name: "Send next" })).toBeTruthy();
        expect(sendCalls()).toHaveLength(0);
    });

    it("keeps the reason a refused interrupt left behind beside the paused queue, after its toast", async () => {
        mount({
            ...session(),
            "acp.remote.cancelHostTurn:error": new Error("refused"),
            "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" },
        });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "use the other fixture" } });
        fireEvent.click(screen.getByRole("button", { name: "Interrupt and send" }));

        expect(await screen.findByText("Could not stop the reply. Your message is queued; send it next when you are ready.")).toBeTruthy();
    });

    it("does not show a failed stop for an interrupting message the person removed while the stop was in flight", async () => {
        const { promise, release } = gate();

        harness.cancelGate = promise;
        mount({
            ...session(),
            "acp.remote.cancelHostTurn:error": new Error("refused"),
            "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" },
        });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "interrupting" } });
        fireEvent.click(screen.getByRole("button", { name: "Interrupt and send" }));
        await waitFor(() => expect(harness.calls.some(([name]) => name === "acp.remote.cancelHostTurn")).toBe(true));

        // The person removes the interrupting message, and queues another, while the stop is still in flight.
        const interrupting = usePromptQueueStore.getState().queues["thread-1"]?.items[0];

        usePromptQueueStore.getState().remove("thread-1", interrupting?.id ?? "");
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "other" });
        release();

        // The stop's failure concerned the message that was removed, so nothing is shown beside the queue for "other".
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
        expect(screen.queryByText("Could not stop the reply. Your message is queued; send it next when you are ready.")).toBeNull();
    });

    it("keeps an interrupting message that was edited while its stop was in flight paused when the stop fails", async () => {
        const { promise, release } = gate();

        harness.cancelGate = promise;
        mount({
            ...session(),
            "acp.remote.cancelHostTurn:error": new Error("refused"),
            "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" },
        });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "interrupting" } });
        fireEvent.click(screen.getByRole("button", { name: "Interrupt and send" }));
        await waitFor(() => expect(harness.calls.some(([name]) => name === "acp.remote.cancelHostTurn")).toBe(true));

        // The person edits the interrupting message while the stop is in flight: the edit gives it a new id.
        fireEvent.click(await screen.findByRole("button", { name: EDIT_BUTTON }));
        fireEvent.change(screen.getByLabelText("Edit queued message"), { target: { value: "interrupting, edited" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(usePromptQueueStore.getState().queues["thread-1"]?.items.map((item) => item.text)).toEqual(["interrupting, edited"]);
        release();
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        // The reply ends: the edited message waits for Send next rather than going on its own. A send, if the queue let one go,
        // would come right after the turn's end, so the wait covers that.
        await endTurn("finished");
        await new Promise((resolve) => {
            setTimeout(resolve, 100);
        });
        expect(sendCalls()).toHaveLength(0);
        expect(await screen.findByRole("button", { name: "Send next" })).toBeTruthy();
    });

    it("queues a second interrupt behind the first while the first still waits for the reply to end", async () => {
        mount({
            ...session(),
            "auth.functions.getUserSettings": { hostFollowUpSteer: true },
            "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" },
        });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "first" } });
        fireEvent.click(screen.getByRole("button", { name: "Interrupt and send" }));
        await waitFor(() => expect(harness.calls.some(([name]) => name === "acp.remote.cancelHostTurn")).toBe(true));

        // The stop has answered, but the reply's end has not been seen, so the first message still waits and the next message
        // is not an interrupt: it queues.
        fireEvent.change(box, { target: { value: "second" } });
        expect(await screen.findByRole("button", { name: "Queue" })).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Queue" }));

        expect(usePromptQueueStore.getState().queues["thread-1"]?.items.map((item) => item.text)).toEqual(["first", "second"]);
        expect(sendCalls()).toHaveLength(0);
    });

    it("pauses the queue when the turn was cancelled on the computer, so queued messages wait for Send next", async () => {
        mount({ ...session(), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        await screen.findByLabelText("Message to the coding agent");
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "queued behind" });
        await endTurn("cancelled");

        expect(await screen.findByRole("button", { name: "Send next" })).toBeTruthy();
        expect(sendCalls()).toHaveLength(0);
    });

    it("queues a message typed right after a send, before the stream shows the turn running", async () => {
        mount(session());

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "first" } });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        await waitFor(() => expect(box.value).toBe(""));

        fireEvent.change(box, { target: { value: "second" } });
        fireEvent.keyDown(box, { key: "Enter" });

        expect(await screen.findByText("second")).toBeTruthy();
        expect(sendCalls()).toHaveLength(1);
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

    it("edits a queued message in place, keeping its place in the queue", async () => {
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "first draft" });
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "second" });
        mount({ ...session(), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        const editButtons = await screen.findAllByRole("button", { name: EDIT_BUTTON });

        fireEvent.click(editButtons[0] as HTMLElement);
        fireEvent.change(screen.getByLabelText("Edit queued message"), { target: { value: "rewritten" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("rewritten")).toBeTruthy();
        expect(screen.queryByText("first draft")).toBeNull();
        const queued = within(screen.getByRole("region", { name: "Queued messages" })).getAllByRole("listitem");

        expect(queued[0]?.textContent).toContain("rewritten");
        expect(queued[1]?.textContent).toContain("second");

        await endTurn();

        // What goes out is the edited text, never the text it replaced.
        await waitFor(() => expect(sendCalls()).toHaveLength(1));
        expect(sendCalls()[0]).toEqual(["send", { requestId: expect.any(String), text: "rewritten", threadId: "thread-1" }]);
    });

    it("sends a queued message next on Send now, by stopping the reply, and sends it once", async () => {
        mount({ ...session(), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        // Queued in this composer: a message queued before it mounted may have been sent already, so it never stops a turn.
        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        for (const text of ["first", "urgent"]) {
            fireEvent.change(box, { target: { value: text } });
            fireEvent.click(screen.getByRole("button", { name: "Queue" }));
            await screen.findByText(text);
        }

        const sendNow = await screen.findByRole("button", { name: "Send queued message 2 now" });

        // Off until the reads have answered, as every queue action is.
        await waitFor(() => expect((sendNow as HTMLButtonElement).disabled).toBe(false));
        fireEvent.click(sendNow);

        await waitFor(() => expect(harness.calls).toContainEqual(["acp.remote.cancelHostTurn", { streamId: "stream-1", threadId: "thread-1" }]));
        // It waits for the stopped turn's end, at the head.
        expect(sendCalls()).toHaveLength(0);
        expect(within(screen.getByRole("region", { name: "Queued messages" })).getAllByRole("listitem")[0]?.textContent).toContain("urgent");

        await endTurn("stopped");

        await waitFor(() => expect(sendCalls()).toHaveLength(1));
        expect(sendCalls()[0]).toEqual(["send", { requestId: expect.any(String), text: "urgent", threadId: "thread-1" }]);
        await waitFor(() => expect(screen.queryByText("urgent")).toBeNull());

        await endTurn();

        await waitFor(() => expect(sendCalls()).toHaveLength(2));
        expect(sendCalls().map(([, args]: [string, unknown]) => (args as { text: string }).text)).toEqual(["urgent", "first"]);
    });

    it("interrupts the turn on Enter when the person chose to send during a turn", async () => {
        mount({
            ...session(),
            "auth.functions.getUserSettings": { hostFollowUpSteer: true },
            "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" },
        });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "use the other fixture" } });
        await waitFor(() => expect(box.value).toBe("use the other fixture"));
        fireEvent.keyDown(box, { key: "Enter" });

        await waitFor(() => expect(harness.calls).toContainEqual(["acp.remote.cancelHostTurn", { streamId: "stream-1", threadId: "thread-1" }]));
        expect(sendCalls()).toHaveLength(0);
    });

    it("sends a queued message after a turn that finished, even though the turn before it failed", async () => {
        mount({ ...session({ lastEndReason: "failed" }), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "after the finish" } });
        fireEvent.click(screen.getByRole("button", { name: "Queue" }));
        await screen.findByText("after the finish");
        await endTurn("finished");

        await waitFor(() => expect(sendCalls()).toHaveLength(1));
        expect(screen.queryByRole("button", { name: "Send next" })).toBeNull();
    });

    it("pauses the queue when the turn ends in failure, so the message waits for the person", async () => {
        mount({ ...session(), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "waits for the person" } });
        fireEvent.click(screen.getByRole("button", { name: "Queue" }));
        await screen.findByText("waits for the person");
        await endTurn("failed");

        expect(await screen.findByRole("button", { name: "Send next" })).toBeTruthy();
        expect(sendCalls()).toHaveLength(0);
    });

    it("pauses a queue on arrival when its thread's last turn failed while the composer was away", async () => {
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "left behind" });
        mount(session({ lastEndReason: "failed" }));

        expect(await screen.findByRole("button", { name: "Send next" })).toBeTruthy();
        expect(sendCalls()).toHaveLength(0);
    });

    it("sends a queued message once the session and stream load, when they were still loading on arrival", async () => {
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "waiting" });
        const { promise, release } = gate();

        harness.gate = promise;
        harness.hold = ["acp.functions.getHostSession", "chat.streaming.getActiveStreamForThread"];
        mount({ "acp.functions.getHostSession": { status: "idle" }, "chat.streaming.getActiveStreamForThread": null });

        expect(await screen.findByText("waiting")).toBeTruthy();
        expect(sendCalls()).toHaveLength(0);

        harness.hold = [];
        release();

        await waitFor(() => expect(sendCalls()).toHaveLength(1));
    });

    it("does not send a queued message while its editor is open, and sends it once the edit is cancelled", async () => {
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "being edited" });
        mount({ ...session(), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        const editButtons = await screen.findAllByRole("button", { name: EDIT_BUTTON });

        fireEvent.click(editButtons[0] as HTMLElement);
        await endTurn();

        expect(await screen.findByLabelText("Edit queued message")).toBeTruthy();
        expect(sendCalls()).toHaveLength(0);

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

        await waitFor(() => expect(sendCalls()).toHaveLength(1));
    });

    it("interrupts the turn from the primary button when the setting is on, as Enter does", async () => {
        mount({
            ...session(),
            "auth.functions.getUserSettings": { hostFollowUpSteer: true },
            "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" },
        });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "primary steer" } });
        await waitFor(() => expect(box.value).toBe("primary steer"));
        fireEvent.click(await screen.findByRole("button", { name: "Interrupt and send" }));

        await waitFor(() => expect(harness.calls).toContainEqual(["acp.remote.cancelHostTurn", { streamId: "stream-1", threadId: "thread-1" }]));
        expect(sendCalls()).toHaveLength(0);
    });

    it("sends a queued retry of a lost direct send under the same request id, so the backend starts no second turn", async () => {
        harness.sendResults = [{ error: "unreachable", ok: false }];
        mount(session());

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "lost draft" } });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        await waitFor(() => expect(sendCalls()).toHaveLength(1));

        // The turn is now running; the draft is still in the box, so Queue is a retry of the same message.
        harness.data = { ...harness.data, "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } };
        await harness.client?.invalidateQueries();
        fireEvent.click(await screen.findByRole("button", { name: "Queue" }));
        await screen.findByText("lost draft");
        await endTurn();

        await waitFor(() => expect(sendCalls()).toHaveLength(2));
        const [first, second] = sendCalls().map(([, input]) => (input as { requestId: string }).requestId);

        expect(second).toBe(first);
    });

    it("moves focus into the editor when an edit opens", async () => {
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "focus me" });
        mount({ ...session(), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        const editButtons = await screen.findAllByRole("button", { name: EDIT_BUTTON });

        fireEvent.click(editButtons[0] as HTMLElement);

        // No Testing Library query exposes the focused element, so the focus is read from the document.
        // eslint-disable-next-line testing-library/no-node-access
        expect(document.activeElement).toBe(screen.getByLabelText("Edit queued message"));
    });

    it("does not release the queue while a running turn still reports no end reason", async () => {
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "after the failure" });
        mount({ ...session(), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        expect(await screen.findByText("after the failure")).toBeTruthy();
        // The stream has cleared, but the session still reports no end reason: the turn's end is not known yet.
        harness.data = { ...harness.data, "chat.streaming.getActiveStreamForThread": null };
        await harness.client?.invalidateQueries();

        expect(sendCalls()).toHaveLength(0);
        await endTurn("failed");

        expect(await screen.findByRole("button", { name: "Send next" })).toBeTruthy();
        expect(sendCalls()).toHaveLength(0);
    });

    it("keeps the reason a queued message did not go out, beside the paused queue", async () => {
        harness.sendResults = [{ error: "unreachable", ok: false }];
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "will fail" });
        mount(session());

        expect(await screen.findByText("Could not reach the server. Try again.")).toBeTruthy();
        expect(screen.getByRole("alert").textContent).toBe("Could not reach the server. Try again.");
    });

    it("does not pause the queue for a refused send whose message was already delivered elsewhere", async () => {
        harness.sendResults = [{ error: "unreachable", ok: false }];
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "delivered elsewhere" });
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "behind it" });
        const headId = usePromptQueueStore.getState().queues["thread-1"]?.items[0]?.id ?? "";

        // Another composer delivers the head while this send is still in flight.
        harness.onSend = () => usePromptQueueStore.getState().remove("thread-1", headId);
        mount(session());

        await waitFor(() => expect(sendCalls()).toHaveLength(2));
        expect(screen.queryByRole("button", { name: "Send next" })).toBeNull();
    });

    it("pauses a queued message the backend refuses as a running turn, and says why", async () => {
        harness.sendResults = [{ error: "turn_running", ok: false }];
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "waits for the turn" });
        mount(session());

        expect(await screen.findByRole("alert")).toBeTruthy();
        expect(screen.getByRole("alert").textContent).toBe("The agent is still working on the last message.");
        expect(await screen.findByRole("button", { name: "Send next" })).toBeTruthy();
        expect(sendCalls()).toHaveLength(1);
    });

    it("waits for another tab's running turn instead of pausing, when a refused head's turn is already running", async () => {
        harness.sendResults = [{ error: "turn_running", ok: false }];
        // The other tab's turn is running on the stream this composer reads again after the refusal. That re-read is held until
        // the test lets it go, so a drain that did not wait for it would post the head a second time in the meantime.
        const hold = gate();

        harness.onSend = () => {
            harness.onSend = undefined;
            harness.data = { ...harness.data, "chat.streaming.getActiveStreamForThread": { streamId: "stream-2" } };
            harness.hold = ["chat.streaming.getActiveStreamForThread"];
            harness.gate = hold.promise;
        };
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "waits for the other tab's turn" });
        mount(session());

        await waitFor(() => expect(sendCalls()).toHaveLength(1));
        // While the re-read is held, the head is not posted again.
        await new Promise((resolve) => {
            setTimeout(resolve, 50);
        });
        expect(sendCalls()).toHaveLength(1);

        harness.hold = [];
        hold.release();
        // The re-read has landed once the composer shows the other tab's turn running.
        expect(await screen.findByRole("button", { name: "Stop" })).toBeTruthy();

        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.queryByRole("button", { name: "Send next" })).toBeNull();
        expect(usePromptQueueStore.getState().queues["thread-1"]?.items).toHaveLength(1);
        // The refused head is not posted again while the stream is re-read.
        expect(sendCalls()).toHaveLength(1);

        // The turn ends: the message that waited goes out.
        await endTurn("finished");

        await waitFor(() => expect(sendCalls()).toHaveLength(2));
    });

    it("pauses the queue when a failed turn ends while a replacement turn is already running", async () => {
        mount({
            ...session(),
            "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" },
        });

        await screen.findByLabelText("Message to the coding agent");
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "behind the failed turn" });

        // The failed turn ended and a replacement turn is running: the session's last reason is the replacement's, not the failure.
        harness.data = {
            ...harness.data,
            "acp.functions.getHostSession": {
                lastEndedReason: "failed",
                lastEndStreamId: "stream-9",
                status: "busy",
            },
            "chat.streaming.getActiveStreamForThread": { streamId: "stream-2" },
        };
        await harness.client?.invalidateQueries();

        expect(await screen.findByRole("button", { name: "Send next" })).toBeTruthy();

        // The replacement finishes: the message stays held for Send next.
        await endTurn("finished");
        await new Promise((resolve) => {
            setTimeout(resolve, 50);
        });
        expect(sendCalls()).toHaveLength(0);
    });

    it("clears the refusal reason once the refused head is edited to a new text", async () => {
        harness.sendResults = [{ error: "unreachable", ok: false }];
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "old text" });
        mount(session());

        expect(await screen.findByRole("alert")).toBeTruthy();
        const editButtons = await screen.findAllByRole("button", { name: EDIT_BUTTON });

        fireEvent.click(editButtons[0] as HTMLElement);
        fireEvent.change(screen.getByLabelText("Edit queued message"), { target: { value: "new text" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    });

    it("does not pause an empty queue when a turn fails, so the next message the person queues goes out", async () => {
        mount({ ...session(), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        await screen.findByLabelText("Message to the coding agent");
        await endTurn("failed");

        expect(usePromptQueueStore.getState().queues["thread-1"]?.paused ?? false).toBe(false);
    });

    it("keeps the refusal reason when a later message is removed, since the head is still refused", async () => {
        harness.sendResults = [{ error: "unreachable", ok: false }];
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "refused head" });
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "later one" });
        mount(session());

        expect(await screen.findByRole("alert")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Remove queued message 2" }));

        expect(screen.getByRole("alert").textContent).toBe("Could not reach the server. Try again.");
    });

    it("queues a message sent while the session is starting, rather than sending it into the startup", async () => {
        mount(session({ status: "starting" }));

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "during startup" } });
        // A keystroke reaches a focused field: focus the box first, as the person's Enter would find it.
        box.focus();
        fireEvent.keyDown(box, { key: "Enter" });

        expect(await screen.findByText("during startup")).toBeTruthy();
        expect(sendCalls()).toHaveLength(0);
    });

    it("keeps a queue that was paused before an interrupt paused after the interrupt stops the reply", async () => {
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "held behind" });
        mount({ ...session(), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        // Stop pauses the queue; the interrupting message then goes first, and the held one waits behind it.
        fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "interrupting" } });
        fireEvent.click(screen.getByRole("button", { name: "Interrupt and send" }));
        await waitFor(() => expect(harness.calls).toContainEqual(["acp.remote.cancelHostTurn", { streamId: "stream-1", threadId: "thread-1" }]));
        await endTurn();

        // The interrupting message goes next; the message held behind it still waits for Send next.
        await waitFor(() => expect(sendCalls()).toHaveLength(1));
        expect(sendCalls()[0]).toEqual(["send", { requestId: expect.any(String), text: "interrupting", threadId: "thread-1" }]);
        expect(await screen.findByRole("button", { name: "Send next" })).toBeTruthy();
    });

    it("sends an interrupting text under a new id, so a stopped lost-answer send cannot turn its resend into a duplicate", async () => {
        harness.sendResults = [{ error: "unreachable", ok: false }];
        mount(session());

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "already sent" } });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        await waitFor(() => expect(sendCalls()).toHaveLength(1));

        // The turn is running and the draft is still in the box, so Interrupt and send sends the same text again.
        harness.data = { ...harness.data, "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } };
        await harness.client?.invalidateQueries();
        fireEvent.click(await screen.findByRole("button", { name: "Interrupt and send" }));

        await endTurn();
        await waitFor(() => expect(sendCalls()).toHaveLength(2));
        const [first, second] = sendCalls().map(([, input]) => (input as { requestId: string }).requestId);

        expect(second).not.toBe(first);
    });

    it("does not pause a message queued during startup for the previous agent's failure, and sends it once the session opens", async () => {
        const { promise, release } = gate();

        harness.gate = promise;
        harness.hold = ["acp.functions.getHostSession"];
        mount({
            "acp.functions.getHostSession": { lastEndReason: "failed", status: "starting" },
            "chat.streaming.getActiveStreamForThread": null,
        });

        // Queued while the session is still loading and starting, before its state has arrived.
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "queued at startup" });
        release();
        await waitFor(() => expect(usePromptQueueStore.getState().queues["thread-1"]?.items).toHaveLength(1));

        harness.data = { ...harness.data, "acp.functions.getHostSession": { lastEndReason: "failed", status: "idle" } };
        await harness.client?.invalidateQueries();

        await waitFor(() => expect(sendCalls()).toHaveLength(1));
    });

    it("does not act on the cached state of a remounted chat until its live read has answered", async () => {
        const { promise, release } = gate();

        harness.gate = promise;
        harness.hold = ["chat.streaming.getActiveStreamForThread"];
        harness.data = { ...session(), "chat.streaming.getActiveStreamForThread": { streamId: "stream-2" } };

        // What the composer saw when it was last open: the thread was idle, and a turn has started since.
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        harness.client = client;
        client.setQueryData(["acp.functions.getHostSession", { threadId: "thread-1" }], { status: "idle" });
        client.setQueryData(["chat.streaming.getActiveStreamForThread", { threadId: "thread-1", unlockProof: undefined }], null);
        render(
            <QueryClientProvider client={client}>
                <HostComposer threadId="thread-1" />
            </QueryClientProvider>,
        );
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "queued after the remount" });

        // The cached idle state must not send the message while the live read is still pending.
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
        expect(sendCalls()).toHaveLength(0);

        // The live read answers: a turn is running, so the message waits for it rather than being refused.
        release();
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
        expect(sendCalls()).toHaveLength(0);
    });

    it("sends a queued message after a remount that takes an idle chat from the cache, once the reads are asked again", async () => {
        harness.data = { ...session(), "chat.streaming.getActiveStreamForThread": null };
        // Lunora's queries never go stale, so a remount takes the cache and nothing refetches it on its own.
        const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });

        harness.client = client;
        client.setQueryData(["acp.functions.getHostSession", { threadId: "thread-1" }], { status: "idle" });
        client.setQueryData(["chat.streaming.getActiveStreamForThread", { threadId: "thread-1", unlockProof: undefined }], null);
        render(
            <QueryClientProvider client={client}>
                <HostComposer threadId="thread-1" />
            </QueryClientProvider>,
        );
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "queued after the remount" });

        // Lunora's queries never go stale, so the cached reads are only trusted once they have been asked again.
        await waitFor(() => expect(sendCalls()).toHaveLength(1));
    });

    it("keeps an interrupting message held, with the reason, when the stop ended the stream but did not reach the computer", async () => {
        harness.data = {
            ...session(),
            "acp.remote.cancelHostTurn:result": { cancelled: true, delivered: false },
            "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" },
        };
        mount(harness.data);

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "interrupting" } });
        fireEvent.click(screen.getByRole("button", { name: "Interrupt and send" }));

        expect(
            await screen.findByText(
                "The reply stopped, but the stop did not reach the computer, so the agent may still be running. Send next once it has stopped.",
            ),
        ).toBeTruthy();
        expect(await screen.findByRole("button", { name: "Send next" })).toBeTruthy();
        expect(sendCalls()).toHaveLength(0);
    });

    it("interrupts the live host turn the session reports, even beside another live stream", async () => {
        mount({
            ...session({ liveStreamId: "host-stream-2" }),
            "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" },
        });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "steer the host turn" } });
        fireEvent.click(screen.getByRole("button", { name: "Interrupt and send" }));

        await waitFor(() => expect(harness.calls).toContainEqual(["acp.remote.cancelHostTurn", { streamId: "host-stream-2", threadId: "thread-1" }]));
    });

    it("pauses the queue for a turn that started and failed between observations, without waiting out the send hold", async () => {
        mount(session({ lastEndReason: "finished", lastEndStreamId: "stream-0" }));

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        // The first message is sent: its hold stays until the composer sees its turn start or end.
        fireEvent.change(box, { target: { value: "first" } });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        await waitFor(() => expect(sendCalls()).toHaveLength(1));

        fireEvent.change(box, { target: { value: "second" } });
        fireEvent.click(screen.getByRole("button", { name: "Queue" }));

        // The turn started and failed without the composer ever seeing it running: only the end stream changed.
        harness.data = {
            ...harness.data,
            "acp.functions.getHostSession": { lastEndReason: "failed", lastEndedReason: "failed", lastEndStreamId: "stream-1", status: "idle" },
            "chat.streaming.getActiveStreamForThread": null,
        };
        await harness.client?.invalidateQueries();

        fireEvent.click(await screen.findByRole("button", { name: "Send next" }, { timeout: 1000 }));

        // The hold ended with the observed end, so Send next goes out at once rather than after the five-second hold.
        await waitFor(() => expect(sendCalls()).toHaveLength(2), { timeout: 1000 });
    });

    it("does not send a queued message that a closed composer had asked the drain lock for", async () => {
        const queues = new Map<string, Promise<unknown>>();
        const fakeLocks = {
            request: (name: string, options: { signal?: AbortSignal }, callback: () => unknown) => {
                const previous = queues.get(name) ?? Promise.resolve();
                const run = previous.then(() => {
                    if (options.signal?.aborted === true) {
                        throw new DOMException("aborted", "AbortError");
                    }

                    return callback();
                });

                queues.set(
                    name,
                    run.then(() => undefined).catch(() => undefined),
                );

                return run;
            },
        };
        const { promise: other, release: releaseOther } = gate();

        Object.defineProperty(globalThis.navigator, "locks", { configurable: true, value: fakeLocks });
        void fakeLocks.request("neore-host-queue:thread-1", {}, () => other);

        try {
            const { unmount } = mount(session());

            await screen.findByLabelText("Message to the coding agent");
            usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "queued before the close" });
            await new Promise((resolve) => {
                setTimeout(resolve, 0);
            });

            // The composer is closed while its request waits for the lock; the other tab then lets go.
            unmount();
            releaseOther();
            await new Promise((resolve) => {
                setTimeout(resolve, 0);
            });

            expect(sendCalls()).toHaveLength(0);
        } finally {
            Reflect.deleteProperty(globalThis.navigator, "locks");
        }
    });

    it("lets the drain lock go when its composer closes during a send, so another tab's queue is not held behind it", async () => {
        const queues = new Map<string, Promise<unknown>>();
        const fakeLocks = {
            request: (name: string, options: { signal?: AbortSignal }, callback: () => unknown) => {
                const previous = queues.get(name) ?? Promise.resolve();
                const run = previous.then(() => {
                    if (options.signal?.aborted === true) {
                        throw new DOMException("aborted", "AbortError");
                    }

                    return callback();
                });

                queues.set(
                    name,
                    run.then(() => undefined).catch(() => undefined),
                );

                return run;
            },
        };
        let otherTabRan = false;

        // The send never settles: the composer holds the lock for as long as it is open.
        harness.gate = new Promise<void>(() => {
            // never settles
        });
        Object.defineProperty(globalThis.navigator, "locks", { configurable: true, value: fakeLocks });

        try {
            const { unmount } = mount(session());

            await screen.findByLabelText("Message to the coding agent");
            usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "sent under the lock" });
            await waitFor(() => expect(sendCalls()).toHaveLength(1));

            // The composer closes while its send holds the lock. Another tab's queue for the thread must be granted it.
            unmount();
            void fakeLocks.request("neore-host-queue:thread-1", {}, () => {
                otherTabRan = true;
            });

            await waitFor(() => expect(otherTabRan).toBe(true));
        } finally {
            harness.gate = undefined;
            Reflect.deleteProperty(globalThis.navigator, "locks");
        }
    });

    it("does not send a queued message while another tab holds the drain lock, and does not send once that tab's turn runs", async () => {
        const queues = new Map<string, Promise<unknown>>();
        const fakeLocks = {
            request: (name: string, options: { signal?: AbortSignal }, callback: () => unknown) => {
                const previous = queues.get(name) ?? Promise.resolve();
                // A request aborted while it waits is not granted, so its callback never runs.
                const run = previous.then(() => {
                    if (options.signal?.aborted === true) {
                        throw new DOMException("aborted", "AbortError");
                    }

                    return callback();
                });

                queues.set(
                    name,
                    run.then(() => undefined).catch(() => undefined),
                );

                return run;
            },
        };

        Object.defineProperty(globalThis.navigator, "locks", { configurable: true, value: fakeLocks });

        // Another tab holds the thread's drain lock until its test releases it.
        const { promise: other, release: releaseOther } = gate();

        void fakeLocks.request("neore-host-queue:thread-1", {}, () => other);

        try {
            mount(session());
            await screen.findByLabelText("Message to the coding agent");
            usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "waits for the other tab" });

            await new Promise((resolve) => {
                setTimeout(resolve, 0);
            });
            expect(sendCalls()).toHaveLength(0);

            // The other tab's turn starts, then the lock is released: this tab must see the turn running and keep waiting.
            harness.data = { ...harness.data, "chat.streaming.getActiveStreamForThread": { streamId: "stream-2" } };
            await harness.client?.invalidateQueries();
            releaseOther();
            await new Promise((resolve) => {
                setTimeout(resolve, 0);
            });

            expect(sendCalls()).toHaveLength(0);
        } finally {
            Reflect.deleteProperty(globalThis.navigator, "locks");
        }
    });

    it("says why the queue waits when a read of the chat fails, and sends once a retry reads it", async () => {
        harness.fail = ["acp.functions.getHostSession"];
        mount(session());

        await screen.findByLabelText("Message to the coding agent");
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "queued while unread" });

        expect(await screen.findByText("The chat's state could not be read, so queued messages wait.")).toBeTruthy();
        expect(sendCalls()).toHaveLength(0);

        harness.fail = [];
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));

        await waitFor(() => expect(sendCalls()).toHaveLength(1));
        expect(sendCalls()[0]).toEqual(["send", { requestId: expect.any(String), text: "queued while unread", threadId: "thread-1" }]);
    });

    it("keeps a queued message when its edit is only hidden characters", async () => {
        mount({ ...session(), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        await screen.findByLabelText("Message to the coding agent");
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "keep me" });
        fireEvent.click(await screen.findByRole("button", { name: EDIT_BUTTON }));
        fireEvent.change(screen.getByLabelText("Edit queued message"), { target: { value: "​" } });

        // Save is disabled for text that is only hidden characters, which is what the person sees; the queue keeps its text.
        expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
        // The disabled Save says why, since the field does not look empty.
        expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-describedby")).toBe("host-queue-edit-note");
        expect(screen.getByText("This text is only hidden characters, so there is nothing to save.")).toBeTruthy();
        expect(usePromptQueueStore.getState().queues["thread-1"]?.items.map((item) => item.text)).toEqual(["keep me"]);
    });

    it("sends the next queued message at once when the turn ended while the send's answer was in flight", async () => {
        const { promise, release } = gate();

        harness.sendGate = promise;
        mount(session());

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "first" } });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        await waitFor(() => expect(sendCalls()).toHaveLength(1));

        // The turn starts and ends while the answer is still in flight, and a message is queued behind it.
        harness.data = { ...harness.data, "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } };
        await harness.client?.invalidateQueries();
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "second" });
        await endTurn("finished");
        // Let the effects that follow the turn's end run before the answer lands, as they do in the app.
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        release();

        // The answer lands after the turn is over, so nothing is left to wait for: the hold timer (5 s) must not apply.
        await waitFor(() => expect(sendCalls()).toHaveLength(2), { timeout: 1000 });
    });

    it("still pauses the queue for a failed turn when a newer turn starts before that end is decided", async () => {
        mount({ ...session({ lastEndReason: "failed" }), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        await screen.findByLabelText("Message to the coding agent");
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "queued behind" });

        // The turn fails, with the same reason as the turn before it: its own end stream says it is a new end.
        await endTurn("failed");
        // Let the composer render the end before the newer turn starts, so the end is seen rather than skipped.
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        // A newer turn starts first; the session reports no reason while it runs.
        harness.data = {
            ...harness.data,
            "acp.functions.getHostSession": { status: "busy" },
            "chat.streaming.getActiveStreamForThread": { streamId: "stream-2" },
        };
        await harness.client?.invalidateQueries();

        // The failed end paused the queue at once, and the newer turn does not lift it.
        await waitFor(() => expect(usePromptQueueStore.getState().queues["thread-1"]?.paused).toBe(true), { timeout: 1000 });
        expect(await screen.findByRole("button", { name: "Send next" })).toBeTruthy();
    });

    it("does not pause the messages behind an interrupt when its own stop ends the turn together with the new stream id", async () => {
        mount({
            ...session(),
            "auth.functions.getUserSettings": { hostFollowUpSteer: true },
            "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" },
        });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "interrupting" } });
        fireEvent.click(screen.getByRole("button", { name: "Interrupt and send" }));
        await waitFor(() => expect(harness.calls.some(([name]) => name === "acp.remote.cancelHostTurn")).toBe(true));

        fireEvent.change(box, { target: { value: "behind" } });
        fireEvent.click(screen.getByRole("button", { name: "Queue" }));

        // The stream clears and the session reports this composer's own stop, with its new end stream, in one update.
        harness.data = {
            ...harness.data,
            "acp.functions.getHostSession": { lastEndedReason: "stopped", lastEndReason: "stopped", lastEndStreamId: "stream-1", status: "idle" },
            "chat.streaming.getActiveStreamForThread": null,
        };
        await harness.client?.invalidateQueries();

        await waitFor(() => expect(sendCalls()).toHaveLength(1));
        await new Promise((resolve) => {
            setTimeout(resolve, 50);
        });
        expect(screen.queryByRole("button", { name: "Send next" })).toBeNull();
        // The message behind it is still queued, unpaused, waiting for the interrupting text's turn rather than lost.
        expect(usePromptQueueStore.getState().queues["thread-1"]?.items.map((item) => item.text)).toEqual(["behind"]);
        expect(usePromptQueueStore.getState().queues["thread-1"]?.paused).toBe(false);
        expect(screen.getByText("behind")).toBeTruthy();
    });

    it("does not send the interrupting text when the turn's end arrives before the stop's answer, and holds it when the stop did not reach the computer", async () => {
        const answer = gate();

        harness.cancelGate = answer.promise;
        mount({
            ...session(),
            "acp.remote.cancelHostTurn:result": { cancelled: true, delivered: false },
            "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" },
        });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "interrupting" } });
        fireEvent.click(screen.getByRole("button", { name: "Interrupt and send" }));
        await waitFor(() => expect(harness.calls.some(([name]) => name === "acp.remote.cancelHostTurn")).toBe(true));

        // The stopped stream's end is pushed before the stop's own answer.
        await endTurn("stopped");
        await new Promise((resolve) => {
            setTimeout(resolve, 50);
        });
        expect(sendCalls()).toHaveLength(0);

        answer.release();

        expect(await screen.findByRole("button", { name: "Send next" })).toBeTruthy();
        expect(screen.getByRole("alert").textContent).toContain("did not reach the computer");
        expect(sendCalls()).toHaveLength(0);
    });

    it("pauses the queue for a later turn stopped from elsewhere, after its own interrupt's text went out", async () => {
        mount({ ...session(), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "behind" });
        fireEvent.change(box, { target: { value: "interrupting" } });
        fireEvent.click(screen.getByRole("button", { name: "Interrupt and send" }));
        await waitFor(() => expect(harness.calls.some(([name]) => name === "acp.remote.cancelHostTurn")).toBe(true));

        // The interrupting text's turn starts and is stopped from another tab before this composer sees it run: the next read
        // already reports that turn's end.
        harness.onSend = () => {
            harness.onSend = undefined;
            harness.data = {
                ...harness.data,
                "acp.functions.getHostSession": { lastEndedReason: "stopped", lastEndReason: "stopped", lastEndStreamId: "stream-2", status: "idle" },
            };
        };
        await endTurn("stopped");
        await waitFor(() => expect(sendCalls()).toHaveLength(1));
        await harness.client?.invalidateQueries();

        expect(await screen.findByRole("button", { name: "Send next" })).toBeTruthy();
        await new Promise((resolve) => {
            setTimeout(resolve, 50);
        });
        expect(sendCalls()).toHaveLength(1);
    });

    it("sends the next queued message promptly after a turn ends with the same reason as the one before it", async () => {
        mount({ ...session({ lastEndReason: "finished" }), "chat.streaming.getActiveStreamForThread": null });
        await screen.findByLabelText("Message to the coding agent");

        // The turn starts: the stream shows it first, then the session still reports the reason of the turn before.
        harness.data = { ...harness.data, "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } };
        await harness.client?.invalidateQueries();
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "next turn" });
        expect(await screen.findByText("next turn")).toBeTruthy();

        // Mid-turn the session moves on and reports no reason, so the reason the turn started under is stale.
        harness.data = { ...harness.data, "acp.functions.getHostSession": { status: "idle" } };
        await harness.client?.invalidateQueries();
        // Let React render the session's new state before the turn ends, so the intermediate reason is seen.
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
        await endTurn("finished");

        await waitFor(() => expect(sendCalls()).toHaveLength(1), { timeout: 1000 });
    });

    it("holds an interrupting message that a Stop follows, even after the interrupt's stop succeeded", async () => {
        mount({ ...session(), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "interrupting" } });
        fireEvent.click(screen.getByRole("button", { name: "Interrupt and send" }));
        await waitFor(() => expect(harness.calls).toContainEqual(["acp.remote.cancelHostTurn", { streamId: "stream-1", threadId: "thread-1" }]));

        // Stop is pressed before the interrupting message goes out: it stays held.
        fireEvent.click(screen.getByRole("button", { name: "Stop" }));
        await endTurn();

        await screen.findByRole("button", { name: "Send next" });
        expect(sendCalls()).toHaveLength(0);
    });

    it("keeps a failed draft's send id through a queued message that drains successfully, so the draft's retry is the same message", async () => {
        harness.sendResults = [{ error: "unreachable", ok: false }, { ok: true }];
        mount(session());

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "draft" } });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        await waitFor(() => expect(sendCalls()).toHaveLength(1));
        const failedId = (sendCalls()[0]?.[1] as { requestId: string }).requestId;

        // A queued message drains and lands while the draft is still in the box.
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "queued" });
        await waitFor(() => expect(sendCalls()).toHaveLength(2));

        // The draft is retried now: it is queued under the id of the send that failed.
        fireEvent.click(screen.getByRole("button", { name: SEND_OR_QUEUE }));

        expect(usePromptQueueStore.getState().queues["thread-1"]?.items.find((item) => item.text === "draft")?.id).toBe(failedId);
    });

    it("says what Send waits for while the interrupt setting is still loading during a turn", async () => {
        const { promise, release } = gate();

        harness.gate = promise;
        harness.hold = ["auth.functions.getUserSettings"];
        mount({ ...session(), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "after this" } });

        expect(await screen.findByText("Checking whether a message sent now interrupts the reply or waits behind it.")).toBeTruthy();
        release();
        await waitFor(() => expect(screen.queryByText("Checking whether a message sent now interrupts the reply or waits behind it.")).toBeNull());
    });

    it("sends the next queued message once the session reports the turn's end, while the stream read still shows that turn", async () => {
        mount({ ...session(), "chat.streaming.getActiveStreamForThread": { streamId: "stream-1" } });

        await screen.findByLabelText("Message to the coding agent");
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "after the turn" });

        // The session reports stream-1's end; the stream read lags and still names it.
        harness.data = {
            ...harness.data,
            "acp.functions.getHostSession": { lastEndedReason: "finished", lastEndReason: "finished", lastEndStreamId: "stream-1", status: "idle" },
        };
        await harness.client?.invalidateQueries({ queryKey: ["acp.functions.getHostSession"] });

        await waitFor(() => expect(sendCalls()).toHaveLength(1));
        expect(sendCalls()[0]).toEqual(["send", { requestId: expect.any(String), text: "after the turn", threadId: "thread-1" }]);
    });

    it("hides Continue while messages are queued, since they go first", async () => {
        usePromptQueueStore.getState().enqueue("thread-1", { attachments: [], text: "queued first" });
        mount(session({ lastEndReason: "interrupted" }));

        expect(await screen.findByText("queued first")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    });

    it("keeps a paste refusal when Continue succeeds, since the draft it refused is still in the box", async () => {
        mount(session({ lastEndReason: "interrupted" }));

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "a valid draft" } });
        fireEvent.change(box, { target: { value: "x".repeat(120_001) } });
        fireEvent.click(screen.getByRole("button", { name: "Continue" }));

        await waitFor(() => expect(harness.calls).toHaveLength(1));
        await waitFor(() => expect(screen.getAllByRole("status").map((element) => element.id)).toContain("host-composer-limit"));
        expect(box.getAttribute("aria-invalid")).toBe("true");
        expect((screen.getByRole("button", { name: NAME_0 }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("keeps an unsent draft that matches the Continue prompt when Continue succeeds", async () => {
        mount(session({ lastEndReason: "interrupted" }));

        const box = (await screen.findByLabelText("Message to the coding agent")) as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "Continue where you left off." } });
        fireEvent.click(screen.getByRole("button", { name: "Continue" }));

        await waitFor(() => expect(harness.calls).toHaveLength(1));
        // One turn of the event loop lets the mocked send finish before the box is read.
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
        expect(box.value).toBe("Continue where you left off.");
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
