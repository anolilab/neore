// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ASIDE_FIND_EVENT } from "@/features/keyboard/lib/aside-find-target";

import AsidePanel from "./aside-panel";
import { useAsideStore } from "./aside-store";

const chat = vi.hoisted(() => {
    return { isRunning: false };
});
const askAside = vi.hoisted(() => vi.fn());
const addAside = vi.hoisted(() => vi.fn());

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});
vi.mock("@tanstack/react-query", () => {
    return {
        useMutation: () => {
            return { mutateAsync: addAside };
        },
    };
});
vi.mock("@neore/backend/api", () => {
    return { api: { chat: { aside: { askAside: "askAside" } } } };
});
vi.mock("@neore/client-runtime", () => {
    return { useUnlockProof: () => undefined };
});
vi.mock("@neore/ui/hooks/use-streamdown-plugins", () => {
    return { default: () => [] };
});
vi.mock("@neore/ui/components/chat-markdown-components", () => {
    return { chatMarkdownComponents: {} };
});
vi.mock("streamdown", () => {
    return { Streamdown: ({ children }: { children: string }) => <div>{children}</div> };
});
vi.mock("@/lib/lunora/crpc", () => {
    return {
        useAction: () => askAside,
        useCRPC: () => {
            return {
                chat: {
                    aside: {
                        addAsideToThread: {
                            mutationOptions: () => {
                                return {};
                            },
                        },
                    },
                },
            };
        },
    };
});
vi.mock("@/features/chat/core/context/chat-context", () => {
    return { useChatIsRunning: () => chat.isRunning };
});

// `Promise.withResolvers` is not in this project's `lib` target.
const deferred = () => {
    let finish: (value: unknown) => void = () => undefined;
    // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
    const promise = new Promise<unknown>((resolve) => {
        finish = resolve;
    });

    return { promise, resolve: finish };
};

const HIDE_NAME = /^Hide this side question/;

const ask = (question: string) => {
    fireEvent.change(screen.getByLabelText("Your side question"), { target: { value: question } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
};

describe("AsidePanel", () => {
    beforeEach(() => {
        useAsideStore.setState({ byThread: {} });
        chat.isRunning = false;
        askAside.mockReset();
        addAside.mockReset();
    });

    it("is a labelled region and announces the answer in a polite live region", async () => {
        askAside.mockResolvedValue({ answer: "It is safe to repeat.", token: "tok-1", withThread: true });
        render(<AsidePanel threadId="thread-1" />);

        expect(screen.getByRole("region", { name: "Side question" })).toBeTruthy();
        ask("What is idempotent?");

        const live = screen.getByRole("status");

        expect(live.getAttribute("aria-live")).toBe("polite");
        expect(live.textContent).toBe("Thinking…");
        // One call, not a stream: the region says the answer arrived, and the text stays readable in the list.
        await waitFor(() => expect(live.textContent).toBe("Answer ready"));
        expect(screen.getByText("It is safe to repeat.")).toBeTruthy();
        expect(askAside).toHaveBeenCalledWith({ entryId: expect.any(String), question: "What is idempotent?", threadId: "thread-1", unlockProof: undefined });
    });

    it("works while a reply streams, but adds to the thread only once it has finished", async () => {
        chat.isRunning = true;
        askAside.mockResolvedValue({ answer: "Because.", token: "tok-2", withThread: true });
        const { rerender } = render(<AsidePanel threadId="thread-1" />);

        ask("Why?");
        const addButton = (await screen.findByRole("button", { name: "Add to thread" })) as HTMLButtonElement;

        expect(addButton.disabled).toBe(true);
        expect(addAside).not.toHaveBeenCalled();

        chat.isRunning = false;
        rerender(<AsidePanel threadId="thread-1" />);
        addAside.mockResolvedValue({ messageId: "m1" });
        fireEvent.click(screen.getByRole("button", { name: "Add to thread" }));

        await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Added to the thread"));
        expect(addAside).toHaveBeenCalledOnce();
        expect(addAside).toHaveBeenCalledWith({
            answer: "Because.",
            entryId: expect.any(String),
            question: "Why?",
            threadId: "thread-1",
            token: "tok-2",
            unlockProof: undefined,
        });
    });

    it("posts once however often Add to thread is pressed, and waits while it is on its way", async () => {
        askAside.mockResolvedValue({ answer: "Because.", token: "tok-3", withThread: true });
        const pending = deferred();

        addAside.mockReturnValue(pending.promise);
        render(<AsidePanel threadId="thread-1" />);
        ask("Why?");

        const button = (await screen.findByRole("button", { name: "Add to thread" })) as HTMLButtonElement;

        fireEvent.click(button);
        fireEvent.click(button);

        expect(addAside).toHaveBeenCalledOnce();
        expect((screen.getByRole("button", { name: "Adding…" }) as HTMLButtonElement).disabled).toBe(true);

        pending.resolve({ messageId: "m1" });
        await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Added to the thread"));
    });

    it("reads an add that the server says already happened as added", async () => {
        askAside.mockResolvedValue({ answer: "Because.", token: "tok-4", withThread: true });
        addAside.mockRejectedValue({ data: { code: "ASIDE_ALREADY_ADDED" } });
        render(<AsidePanel threadId="thread-1" />);
        ask("Why?");
        fireEvent.click(await screen.findByRole("button", { name: "Add to thread" }));

        expect(await screen.findByText("Added to the thread")).toBeTruthy();
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("does not announce an answer to a question that was hidden meanwhile", async () => {
        const pending = deferred();

        askAside.mockReturnValue(pending.promise);
        render(<AsidePanel threadId="thread-1" />);
        ask("Hidden?");
        fireEvent.click(screen.getByRole("button", { name: HIDE_NAME }));
        pending.resolve({ answer: "Late.", token: "tok-5", withThread: true });

        await waitFor(() => expect(askAside).toHaveBeenCalledOnce());
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(screen.getByRole("status").textContent).toBe("Thinking…");
    });

    it.each([
        ["DAILY_MESSAGE_LIMIT_REACHED", "used today's messages"],
        ["INSUFFICIENT_CREDITS", "no credits left"],
        ["UPSTREAM_RATE_LIMITED", "Try again in a moment"],
        ["TOO_MANY_REQUESTS", "Try again in a moment"],
    ])("words %s on its own", async (code, words) => {
        askAside.mockRejectedValue({ data: { code } });
        render(<AsidePanel threadId="thread-1" />);

        ask("Again?");

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toContain(words);
    });

    it("asks for a conversation first when there is no thread", () => {
        render(<AsidePanel />);

        expect(screen.getByText("Start a conversation to ask a side question.")).toBeTruthy();
        expect(screen.queryByLabelText("Your side question")).toBeNull();
    });

    it("finds the word in the questions and answers, and steps through the hits", () => {
        useAsideStore.setState({
            byThread: {
                "thread-1": [
                    { answer: "Safe to repeat: idempotent calls.", id: "a", question: "What is idempotent?", status: "answered", token: "tok" },
                    { id: "b", question: "Is retry idempotent too?", status: "pending" },
                ],
            },
        });
        render(<AsidePanel threadId="thread-1" />);

        expect(screen.queryByRole("search")).toBeNull();
        act(() => {
            globalThis.dispatchEvent(new CustomEvent(ASIDE_FIND_EVENT));
        });
        const input = screen.getByRole("textbox", { name: "Find in side questions" });

        fireEvent.change(input, { target: { value: "idempotent" } });
        expect(screen.getByText("1 of 3")).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "Next match" }));
        expect(screen.getByText("2 of 3")).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
        fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
        expect(screen.getByText("3 of 3")).toBeTruthy();
    });

    it("brings the current hit into view once the layout has settled, and not for a query that changed first", () => {
        vi.useFakeTimers();

        try {
            useAsideStore.setState({ byThread: { "thread-1": [{ answer: "A cat.", id: "a", question: "Why?", status: "answered", token: "tok" }] } });
            render(<AsidePanel threadId="thread-1" />);
            // jsdom has no layout, so it has no scrollIntoView to spy on: install one for this test.
            const scroll = vi.fn();

            Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scroll });

            act(() => {
                globalThis.dispatchEvent(new CustomEvent(ASIDE_FIND_EVENT));
            });
            const input = screen.getByRole("textbox", { name: "Find in side questions" });

            fireEvent.change(input, { target: { value: "cat" } });
            act(() => {
                vi.advanceTimersByTime(149);
            });
            expect(scroll).not.toHaveBeenCalled();

            act(() => {
                vi.advanceTimersByTime(1);
            });
            expect(scroll).toHaveBeenCalledTimes(1);

            scroll.mockClear();
            fireEvent.change(input, { target: { value: "cat" } });
            fireEvent.change(input, { target: { value: "dog" } });
            act(() => {
                vi.advanceTimersByTime(150);
            });
            expect(scroll).not.toHaveBeenCalled();
        } finally {
            Reflect.deleteProperty(Element.prototype, "scrollIntoView");
            vi.useRealTimers();
        }
    });
    it("brings a hit that arrives with a later answer into view", async () => {
        useAsideStore.setState({ byThread: { "thread-1": [{ id: "a", question: "Why?", status: "pending" }] } });
        render(<AsidePanel threadId="thread-1" />);

        // jsdom has no layout, so it has no scrollIntoView to spy on: install one for this test.
        const scroll = vi.fn();

        Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scroll });

        try {
            act(() => {
                globalThis.dispatchEvent(new CustomEvent(ASIDE_FIND_EVENT));
            });
            fireEvent.change(screen.getByRole("textbox", { name: "Find in side questions" }), { target: { value: "cat" } });

            // The first reveal runs with no hit yet: nothing to bring into view.
            await act(
                () =>
                    new Promise<void>((resolve) => {
                        setTimeout(resolve, 200);
                    }),
            );
            expect(scroll).not.toHaveBeenCalled();

            act(() => {
                useAsideStore.setState({
                    byThread: { "thread-1": [{ answer: "A cat.", id: "a", question: "Why?", status: "answered", token: "tok" }] },
                });
            });

            await waitFor(() => expect(scroll).toHaveBeenCalled());
        } finally {
            Reflect.deleteProperty(Element.prototype, "scrollIntoView");
        }
    });

    it("brings the current hit into view again when an earlier answer pushes it along the panel", async () => {
        // jsdom has no layout: place the hit by hand, so that an answer above it can move it without changing its text.
        let hitTop = 100;
        const hitRect = () => {
            return {
                bottom: hitTop + 20,
                height: 20,
                left: 0,
                right: 0,
                toJSON: () => {
                    return {};
                },
                top: hitTop,
                width: 0,
                x: 0,
                y: hitTop,
            };
        };
        const scroll = vi.fn();
        const answered = { answer: "A cat.", id: "a", question: "Why?", status: "answered", token: "tok" } as const;

        useAsideStore.setState({ byThread: { "thread-1": [answered] } });
        render(<AsidePanel threadId="thread-1" />);

        Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scroll });
        Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: hitRect });

        try {
            act(() => {
                globalThis.dispatchEvent(new CustomEvent(ASIDE_FIND_EVENT));
            });
            fireEvent.change(screen.getByRole("textbox", { name: "Find in side questions" }), { target: { value: "cat" } });
            await waitFor(() => expect(scroll).toHaveBeenCalled());
            scroll.mockClear();

            // An answer above the hit: the hit's text is untouched, but it has moved down the panel out of sight.
            hitTop = 900;
            act(() => {
                useAsideStore.setState({
                    byThread: { "thread-1": [{ answer: "Long.", id: "z", question: "Above?", status: "answered", token: "tok-z" }, answered] },
                });
            });
            await waitFor(() => expect(scroll).toHaveBeenCalled());
            scroll.mockClear();

            // An answer below the hit leaves it where it was: nothing to bring into view.
            act(() => {
                useAsideStore.setState({
                    byThread: {
                        "thread-1": [
                            { answer: "Long.", id: "z", question: "Above?", status: "answered", token: "tok-z" },
                            answered,
                            { id: "y", question: "Below?", status: "pending" },
                        ],
                    },
                });
            });
            await act(
                () =>
                    new Promise<void>((resolve) => {
                        setTimeout(resolve, 200);
                    }),
            );
            expect(scroll).not.toHaveBeenCalled();
        } finally {
            Reflect.deleteProperty(Element.prototype, "scrollIntoView");
            Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
        }
    });
});
