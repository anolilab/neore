// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

/** A constructible ResizeObserver for a test to use: jsdom has no layout to resize, so a test fires its callback by hand. */
function ResizeObserverStub() {
    return { disconnect: vi.fn(), observe: vi.fn(), unobserve: vi.fn() };
}

/** The timers the reveal runs on: its settle delay, and the frame that rechecks the hit after a change. */
const REVEAL_TIMERS = ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] as const;

/** Lets the frame and the settle delay after it run on the fake clock. */
const settleReveal = (): Promise<void> =>
    act(async () => {
        await vi.advanceTimersByTimeAsync(200);
    });

/** The rectangle a selected hit reports in jsdom, which lays out nothing, with its top at `top`. */
const rectAt = (top: number) => {
    return {
        bottom: top + 20,
        height: 20,
        left: 0,
        right: 0,
        toJSON: () => {
            return {};
        },
        top,
        width: 0,
        x: 0,
        y: top,
    };
};

/** Stubs the hit's rectangle: the hit whose text is "too" wide sits far below, every other hit at `top`. */
const stubHitRects = (top: number): void => {
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
        configurable: true,
        value: function rectOfHit(this: Range) {
            // eslint-disable-next-line unicorn/no-this-outside-of-class -- the rect depends on which range is asked, which only the receiver says
            return rectAt(this.startContainer.textContent?.includes("too") ? 900 : top);
        },
    });
};

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
        // A reveal that corrects the window's scroll must not reach jsdom's unimplemented scrollBy.
        vi.stubGlobal("scrollBy", vi.fn());
        // The setup's mock is an arrow function, which cannot be constructed; the effect calls this one with new.
        vi.stubGlobal("ResizeObserver", vi.fn(ResizeObserverStub));
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

    it("does not step to another match for an Enter that only commits an IME candidate", () => {
        useAsideStore.setState({
            byThread: {
                "thread-1": [{ answer: "Safe to repeat: idempotent calls.", id: "a", question: "What is idempotent?", status: "answered", token: "tok" }],
            },
        });
        render(<AsidePanel threadId="thread-1" />);

        act(() => {
            globalThis.dispatchEvent(new CustomEvent(ASIDE_FIND_EVENT));
        });
        const input = screen.getByRole("textbox", { name: "Find in side questions" });

        fireEvent.change(input, { target: { value: "idempotent" } });
        expect(screen.getByText("1 of 2")).toBeTruthy();

        // fireEvent does not run the browser's implicit form submit, so the cancelled event is what shows the submit is blocked.
        expect(fireEvent.keyDown(input, { isComposing: true, key: "Enter" })).toBe(false);
        expect(screen.getByText("1 of 2")).toBeTruthy();

        // Safari marks the Enter that ends a composition with keyCode 229, though isComposing is already false. Shift+Enter is the
        // one Enter that steps, so it is the key that shows the guard.
        fireEvent.keyDown(input, { key: "Enter", keyCode: 229, shiftKey: true });
        expect(screen.getByText("1 of 2")).toBeTruthy();

        // Shift+Enter still steps, so the no-step above is not just a dead handler.
        fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
        expect(screen.getByText("2 of 2")).toBeTruthy();
    });

    it("does not close the bar for an Escape that only cancels an IME candidate", () => {
        useAsideStore.setState({
            byThread: {
                "thread-1": [{ answer: "Safe to repeat: idempotent calls.", id: "a", question: "What is idempotent?", status: "answered", token: "tok" }],
            },
        });
        render(<AsidePanel threadId="thread-1" />);

        act(() => {
            globalThis.dispatchEvent(new CustomEvent(ASIDE_FIND_EVENT));
        });
        const input = screen.getByRole("textbox", { name: "Find in side questions" });

        fireEvent.keyDown(input, { isComposing: true, key: "Escape" });
        expect(screen.getByRole("textbox", { name: "Find in side questions" })).toBeTruthy();

        // Safari marks the Escape that cancels a candidate with keyCode 229, though isComposing is already false.
        fireEvent.keyDown(input, { key: "Escape", keyCode: 229 });
        expect(screen.getByRole("textbox", { name: "Find in side questions" })).toBeTruthy();

        // A plain Escape still closes the bar, so the no-close above is not just a dead handler.
        fireEvent.keyDown(input, { key: "Escape" });
        expect(screen.queryByRole("textbox", { name: "Find in side questions" })).toBeNull();
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
        vi.useFakeTimers({ toFake: [...REVEAL_TIMERS] });
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
            await settleReveal();
            expect(scroll).not.toHaveBeenCalled();

            act(() => {
                useAsideStore.setState({
                    byThread: { "thread-1": [{ answer: "A cat.", id: "a", question: "Why?", status: "answered", token: "tok" }] },
                });
            });

            // The new row is rechecked a frame later, then the hit is revealed once the settle delay has passed.
            await settleReveal();
            expect(scroll).toHaveBeenCalled();
        } finally {
            Reflect.deleteProperty(Element.prototype, "scrollIntoView");
            vi.useRealTimers();
        }
    });

    it("brings the current hit into view again when an earlier answer pushes it along the panel", async () => {
        vi.useFakeTimers({ toFake: [...REVEAL_TIMERS] });
        // jsdom has no layout: place the hit by hand, so that an answer above it can move it without changing its text.
        // Under the sticky find bar, so the first reveal scrolls it.
        let hitTop = 20;
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
            await settleReveal();
            expect(scroll).toHaveBeenCalled();
            scroll.mockClear();

            // An answer above the hit: the hit's text is untouched, but it has moved down the panel out of sight.
            hitTop = 900;
            act(() => {
                useAsideStore.setState({
                    byThread: { "thread-1": [{ answer: "Long.", id: "z", question: "Above?", status: "answered", token: "tok-z" }, answered] },
                });
            });
            await settleReveal();
            expect(scroll).toHaveBeenCalled();
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
            await settleReveal();
            expect(scroll).not.toHaveBeenCalled();
        } finally {
            Reflect.deleteProperty(Element.prototype, "scrollIntoView");
            Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
            vi.useRealTimers();
        }
    });

    it("brings the current hit into view when an image above it loads and pushes it out of sight", async () => {
        vi.useFakeTimers({ toFake: [...REVEAL_TIMERS] });
        // Under the sticky find bar, so the first reveal scrolls it.
        let hitTop = 20;
        const scroll = vi.fn();

        useAsideStore.setState({ byThread: { "thread-1": [{ answer: "A cat.", id: "a", question: "Why?", status: "answered", token: "tok" }] } });
        render(<AsidePanel threadId="thread-1" />);

        // An image in the panel. Its load changes no node, only the layout above the hit.
        const image = document.createElement("img");
        const region = screen.getByRole("region", { name: "Side question" });

        region.insertBefore(image, screen.getByRole("heading", { name: "Side question" }));

        Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scroll });
        Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => rectAt(hitTop) });

        try {
            act(() => {
                globalThis.dispatchEvent(new CustomEvent(ASIDE_FIND_EVENT));
            });
            fireEvent.change(screen.getByRole("textbox", { name: "Find in side questions" }), { target: { value: "cat" } });
            await settleReveal();
            expect(scroll).toHaveBeenCalled();
            scroll.mockClear();

            hitTop = 900;
            act(() => {
                image.dispatchEvent(new Event("load"));
            });
            await settleReveal();
            expect(scroll).toHaveBeenCalled();
        } finally {
            Reflect.deleteProperty(Element.prototype, "scrollIntoView");
            Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
            vi.useRealTimers();
        }
    });

    it("scrolls the panel the rest of the way when centring a block taller than the panel leaves the hit below it", async () => {
        vi.useFakeTimers({ toFake: [...REVEAL_TIMERS] });

        let hitTop = 900;
        // Centring the block moves the hit only part of the way: it is still below the panel's visible bottom.
        const scroll = vi.fn(() => {
            hitTop = 500;
        });
        const scrollBy = vi.fn();

        useAsideStore.setState({ byThread: { "thread-1": [{ answer: "A cat.", id: "a", question: "Why?", status: "answered", token: "tok" }] } });
        render(<AsidePanel threadId="thread-1" />);

        // With no scroll container of its own, the panel is read against the window: a 400 px visible height.
        vi.stubGlobal("innerHeight", 400);
        vi.stubGlobal("scrollBy", scrollBy);

        Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scroll });
        Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => rectAt(hitTop) });

        try {
            act(() => {
                globalThis.dispatchEvent(new CustomEvent(ASIDE_FIND_EVENT));
            });
            fireEvent.change(screen.getByRole("textbox", { name: "Find in side questions" }), { target: { value: "cat" } });
            await settleReveal();

            expect(scroll).toHaveBeenCalledTimes(1);
            // The hit ends at 520, 120 below the panel's visible bottom at 400.
            expect(scrollBy).toHaveBeenCalledWith({ behavior: "instant", left: 0, top: 120 });
        } finally {
            Reflect.deleteProperty(Element.prototype, "scrollIntoView");
            Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
            vi.unstubAllGlobals();
            vi.useRealTimers();
        }
    });

    it("scrolls the panel back down when a scroll box inside it moves the hit under the sticky bar", async () => {
        vi.useFakeTimers({ toFake: [...REVEAL_TIMERS] });

        let hitTop = 900;
        // Centring the hit leaves it at 300, below the sticky bar's band and inside the panel.
        const scroll = vi.fn(() => {
            hitTop = 300;
        });

        useAsideStore.setState({ byThread: { "thread-1": [{ answer: "A cat.", id: "a", question: "Why?", status: "answered", token: "tok" }] } });
        render(<AsidePanel threadId="thread-1" />);

        // The answer is a scroll box of its own, ending at 250, so the hit at 300 lies below it. Scrolling the box by the 70 px
        // that brings the hit back moves it to 40: under the sticky bar, where the panel does not see it.
        const answer = screen.getByText("A cat.");
        const scrollBox = vi.fn(() => {
            hitTop = 40;
        });

        answer.style.overflowY = "auto";
        Object.defineProperties(answer, {
            getBoundingClientRect: {
                configurable: true,
                value: () => {
                    return { bottom: 250, left: 0, right: 1000, top: 0 };
                },
            },
            scrollBy: { configurable: true, value: scrollBox },
        });

        vi.stubGlobal("innerHeight", 400);
        Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scroll });
        Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => rectAt(hitTop) });

        try {
            act(() => {
                globalThis.dispatchEvent(new CustomEvent(ASIDE_FIND_EVENT));
            });
            fireEvent.change(screen.getByRole("textbox", { name: "Find in side questions" }), { target: { value: "cat" } });
            await settleReveal();

            expect(scroll).toHaveBeenCalledTimes(1);
            expect(scrollBox).toHaveBeenCalledWith({ behavior: "instant", left: 0, top: 70 });
            // The hit ends at 40, 16 px above the band the sticky bar covers, so the panel is scrolled back by 16 px.
            expect(window.scrollBy).toHaveBeenCalledWith({ behavior: "instant", left: 0, top: -16 });
        } finally {
            Reflect.deleteProperty(Element.prototype, "scrollIntoView");
            Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
            vi.unstubAllGlobals();
            vi.useRealTimers();
        }
    });

    it("brings the current hit into view again when resizing the panel leaves it out of sight", async () => {
        vi.useFakeTimers({ toFake: [...REVEAL_TIMERS] });
        // Under the sticky find bar, so the first reveal scrolls it.
        let hitTop = 20;
        const scroll = vi.fn();

        useAsideStore.setState({ byThread: { "thread-1": [{ answer: "A cat.", id: "a", question: "Why?", status: "answered", token: "tok" }] } });
        // The sidebar's scroll box is what the panel is resized within.
        render(
            <div data-aside-scroll="">
                <AsidePanel threadId="thread-1" />
            </div>,
        );

        Object.defineProperties(Element.prototype, {
            scrollBy: { configurable: true, value: vi.fn() },
            scrollIntoView: { configurable: true, value: scroll },
        });
        Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => rectAt(hitTop) });

        try {
            act(() => {
                globalThis.dispatchEvent(new CustomEvent(ASIDE_FIND_EVENT));
            });
            fireEvent.change(screen.getByRole("textbox", { name: "Find in side questions" }), { target: { value: "cat" } });
            await settleReveal();
            scroll.mockClear();

            // A narrower box reflows the hit below the visible part, with no DOM change: only the resize observer reports it.
            hitTop = 900;
            const onResize = vi.mocked(ResizeObserver).mock.calls.at(-1)?.[0];
            const observer = vi.mocked(ResizeObserver).mock.results.at(-1)?.value;

            act(() => {
                onResize?.([], observer);
            });
            await settleReveal();
            expect(scroll).toHaveBeenCalled();
        } finally {
            Reflect.deleteProperty(Element.prototype, "scrollIntoView");
            Reflect.deleteProperty(Element.prototype, "scrollBy");
            Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
            vi.useRealTimers();
        }
    });

    it("brings the current hit into view again when the window resizes and leaves it out of sight", async () => {
        vi.useFakeTimers({ toFake: [...REVEAL_TIMERS] });
        // Under the sticky find bar, so the first reveal scrolls it.
        let hitTop = 20;
        const scroll = vi.fn();

        useAsideStore.setState({ byThread: { "thread-1": [{ answer: "A cat.", id: "a", question: "Why?", status: "answered", token: "tok" }] } });
        render(<AsidePanel threadId="thread-1" />);

        Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scroll });
        Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => rectAt(hitTop) });

        try {
            act(() => {
                globalThis.dispatchEvent(new CustomEvent(ASIDE_FIND_EVENT));
            });
            fireEvent.change(screen.getByRole("textbox", { name: "Find in side questions" }), { target: { value: "cat" } });
            await settleReveal();
            scroll.mockClear();

            // A shorter window leaves the hit below its visible part, with no DOM change.
            hitTop = 900;
            act(() => {
                globalThis.dispatchEvent(new Event("resize"));
            });
            await settleReveal();
            expect(scroll).toHaveBeenCalled();
        } finally {
            Reflect.deleteProperty(Element.prototype, "scrollIntoView");
            Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
            vi.useRealTimers();
        }
    });

    it("brings the current hit into view again when an image above it loads and moves it sideways out of a box", async () => {
        vi.useFakeTimers({ toFake: [...REVEAL_TIMERS] });
        // A hit that starts well inside a box which scrolls sideways.
        let hit = { bottom: 120, left: 10, right: 30, top: 100 };
        const scroll = vi.fn();

        useAsideStore.setState({ byThread: { "thread-1": [{ answer: "A cat.", id: "a", question: "Why?", status: "answered", token: "tok" }] } });
        render(
            <div data-testid="sideways-box" style={{ overflowX: "auto" }}>
                <AsidePanel threadId="thread-1" />
            </div>,
        );
        const box = screen.getByTestId("sideways-box");

        Object.defineProperties(box, {
            getBoundingClientRect: {
                configurable: true,
                value: () => {
                    return { bottom: 1000, left: 0, right: 100, top: 0 };
                },
            },
            scrollBy: { configurable: true, value: vi.fn() },
        });
        Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scroll });
        Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => hit });

        try {
            act(() => {
                globalThis.dispatchEvent(new CustomEvent(ASIDE_FIND_EVENT));
            });
            fireEvent.change(screen.getByRole("textbox", { name: "Find in side questions" }), { target: { value: "cat" } });
            await settleReveal();
            expect(scroll).not.toHaveBeenCalled();

            // An image above the hit loads: the hit moves past the box's far edge sideways, with no vertical change.
            const image = document.createElement("img");
            const region = screen.getByRole("region", { name: "Side question" });

            region.insertBefore(image, screen.getByRole("heading", { name: "Side question" }));
            hit = { bottom: 120, left: 150, right: 170, top: 100 };
            act(() => {
                image.dispatchEvent(new Event("load"));
            });
            await settleReveal();
            expect(scroll).toHaveBeenCalled();
        } finally {
            Reflect.deleteProperty(Element.prototype, "scrollIntoView");
            Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
            vi.useRealTimers();
        }
    });

    it("brings a hit that runs past the panel's right edge into view", async () => {
        vi.useFakeTimers({ toFake: [...REVEAL_TIMERS] });
        const scroll = vi.fn();

        useAsideStore.setState({ byThread: { "thread-1": [{ answer: "A cat.", id: "a", question: "Why?", status: "answered", token: "tok" }] } });
        render(<AsidePanel threadId="thread-1" />);

        Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scroll });
        // jsdom's window is 1024 px wide; the hit starts inside it and its unbroken token runs past its right edge.
        Object.defineProperty(Range.prototype, "getBoundingClientRect", {
            configurable: true,
            value: () => {
                return { bottom: 120, left: 1000, right: 1200, top: 100 };
            },
        });

        try {
            act(() => {
                globalThis.dispatchEvent(new CustomEvent(ASIDE_FIND_EVENT));
            });
            fireEvent.change(screen.getByRole("textbox", { name: "Find in side questions" }), { target: { value: "cat" } });
            await settleReveal();
            expect(scroll).toHaveBeenCalled();
            // The panel is shifted left by the part of the hit that runs past the window's right edge, not left to the browser.
            expect(window.scrollBy).toHaveBeenCalledWith({ behavior: "instant", left: 176, top: 0 });
        } finally {
            Reflect.deleteProperty(Element.prototype, "scrollIntoView");
            Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
            vi.useRealTimers();
        }
    });

    it("keeps the selected match in place when an earlier answer adds a match above it", async () => {
        vi.useFakeTimers({ toFake: [...REVEAL_TIMERS] });
        // Under the sticky find bar, so the first reveal scrolls it.
        const hitTop = 20;
        const scroll = vi.fn();
        const answered = { answer: "A cat.", id: "a", question: "Why?", status: "answered", token: "tok" } as const;

        useAsideStore.setState({ byThread: { "thread-1": [answered] } });
        render(<AsidePanel threadId="thread-1" />);

        Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scroll });
        // The new earlier hit sits well out of view. The selected hit does not move, so nothing scrolls.
        stubHitRects(hitTop);

        try {
            act(() => {
                globalThis.dispatchEvent(new CustomEvent(ASIDE_FIND_EVENT));
            });
            fireEvent.change(screen.getByRole("textbox", { name: "Find in side questions" }), { target: { value: "cat" } });
            await settleReveal();
            expect(within(screen.getByRole("search")).getByRole("status").textContent).toBe("1 of 1");
            scroll.mockClear();

            // An earlier entry's answer adds a hit above the selected one. The selection stays on its own hit, now second of two.
            act(() => {
                useAsideStore.setState({
                    byThread: { "thread-1": [{ answer: "A cat too.", id: "z", question: "Above?", status: "answered", token: "tok-z" }, answered] },
                });
            });
            await settleReveal();
            expect(within(screen.getByRole("search")).getByRole("status").textContent).toBe("2 of 2");
            expect(scroll).not.toHaveBeenCalled();
        } finally {
            Reflect.deleteProperty(Element.prototype, "scrollIntoView");
            Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
            vi.useRealTimers();
        }
    });

    it("does not scroll when the selected entry is dismissed and the hit that takes its place is out of view", async () => {
        vi.useFakeTimers({ toFake: [...REVEAL_TIMERS] });
        const hitTop = 20;
        const scroll = vi.fn();
        const answered = { answer: "A cat.", id: "a", question: "Why?", status: "answered", token: "tok" } as const;

        useAsideStore.setState({ byThread: { "thread-1": [answered] } });
        render(<AsidePanel threadId="thread-1" />);

        Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scroll });
        stubHitRects(hitTop);

        try {
            act(() => {
                globalThis.dispatchEvent(new CustomEvent(ASIDE_FIND_EVENT));
            });
            fireEvent.change(screen.getByRole("textbox", { name: "Find in side questions" }), { target: { value: "cat" } });
            await settleReveal();
            scroll.mockClear();

            // The selected entry is replaced by one whose hit sits far below. Its selection falls back to the nearest index,
            // a different hit, and only the identity check keeps the panel from scrolling to it.
            act(() => {
                useAsideStore.setState({
                    byThread: { "thread-1": [{ answer: "A cat too.", id: "z", question: "Below?", status: "answered", token: "tok-z" }] },
                });
            });
            await settleReveal();
            expect(scroll).not.toHaveBeenCalled();
        } finally {
            Reflect.deleteProperty(Element.prototype, "scrollIntoView");
            Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
            vi.useRealTimers();
        }
    });

    it("does not scroll to the hit that replaces a dismissed selection when the dismissal lands inside the reveal delay", async () => {
        vi.useFakeTimers({ toFake: [...REVEAL_TIMERS] });
        const hitTop = 20;
        const scroll = vi.fn();
        const answered = { answer: "A cat.", id: "a", question: "Why?", status: "answered", token: "tok" } as const;

        useAsideStore.setState({ byThread: { "thread-1": [answered] } });
        render(<AsidePanel threadId="thread-1" />);

        Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scroll });
        stubHitRects(hitTop);

        try {
            act(() => {
                globalThis.dispatchEvent(new CustomEvent(ASIDE_FIND_EVENT));
            });
            fireEvent.change(screen.getByRole("textbox", { name: "Find in side questions" }), { target: { value: "cat" } });
            // The reveal is due in 150 ms. The dismissal lands 5 ms before it, so the rescan frame, 16 ms on, comes too late.
            act(() => {
                vi.advanceTimersByTime(145);
            });
            await act(async () => {
                useAsideStore.setState({
                    byThread: { "thread-1": [{ answer: "A cat too.", id: "z", question: "Below?", status: "answered", token: "tok-z" }] },
                });
            });
            await settleReveal();
            expect(scroll).not.toHaveBeenCalled();
        } finally {
            Reflect.deleteProperty(Element.prototype, "scrollIntoView");
            Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
            vi.useRealTimers();
        }
    });

    it("moves focus to the panel when Escape closes the bar after the control that opened it was dismissed", () => {
        useAsideStore.setState({
            byThread: { "thread-1": [{ answer: "A cat.", id: "a", question: "Why?", status: "answered", token: "tok" }] },
        });
        render(<AsidePanel threadId="thread-1" />);
        const dismiss = screen.getByRole("button", { name: "Dismiss this side question" });

        dismiss.focus();
        act(() => {
            globalThis.dispatchEvent(new CustomEvent(ASIDE_FIND_EVENT));
        });
        // Dismissing the row removes the button the bar would otherwise return focus to.
        fireEvent.click(dismiss);
        expect(dismiss.isConnected).toBe(false);

        fireEvent.keyDown(screen.getByRole("textbox", { name: "Find in side questions" }), { key: "Escape" });

        expect(screen.queryByRole("textbox", { name: "Find in side questions" })).toBeNull();
        // eslint-disable-next-line testing-library/no-node-access -- focus placement (document.activeElement) is what this test asserts
        expect(document.activeElement).toBe(screen.getByRole("region", { name: "Side question" }));
    });

    it("keeps the selected hit when the bar is reopened after an earlier entry gains a hit", async () => {
        vi.useFakeTimers({ toFake: [...REVEAL_TIMERS] });
        const b = { answer: "A cat.", id: "b", question: "First", status: "answered", token: "tok-b" } as const;
        const c = { answer: "A cat.", id: "c", question: "Second", status: "answered", token: "tok-c" } as const;

        useAsideStore.setState({ byThread: { "thread-1": [b, c] } });
        render(<AsidePanel threadId="thread-1" />);

        Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
        Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => rectAt(20) });

        try {
            act(() => {
                globalThis.dispatchEvent(new CustomEvent(ASIDE_FIND_EVENT));
            });
            const input = screen.getByRole("textbox", { name: "Find in side questions" });

            fireEvent.change(input, { target: { value: "cat" } });
            fireEvent.click(screen.getByRole("button", { name: "Next match" }));
            await settleReveal();
            expect(within(screen.getByRole("search")).getByRole("status").textContent).toBe("2 of 2");

            // An earlier entry gains a hit, so the selected hit, now third of three, moves down the list.
            act(() => {
                useAsideStore.setState({
                    byThread: { "thread-1": [{ answer: "A cat too.", id: "z", question: "Above?", status: "answered", token: "tok-z" }, b, c] },
                });
            });
            await settleReveal();

            fireEvent.keyDown(input, { key: "Escape" });
            act(() => {
                globalThis.dispatchEvent(new CustomEvent(ASIDE_FIND_EVENT));
            });
            await settleReveal();

            expect(within(screen.getByRole("search")).getByRole("status").textContent).toBe("3 of 3");
        } finally {
            Reflect.deleteProperty(Element.prototype, "scrollIntoView");
            Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
            vi.useRealTimers();
        }
    });

    it("selects the hit that follows a dismissed selection, not the hit at its old index", async () => {
        vi.useFakeTimers({ toFake: [...REVEAL_TIMERS] });
        const b = { answer: "A cat.", id: "b", question: "First", status: "answered", token: "tok-b" } as const;
        const c = { answer: "A cat.", id: "c", question: "Second", status: "answered", token: "tok-c" } as const;
        const d = { answer: "A cat.", id: "d", question: "Third", status: "answered", token: "tok-d" } as const;
        const scroll = vi.fn();

        useAsideStore.setState({ byThread: { "thread-1": [b, c, d] } });
        render(<AsidePanel threadId="thread-1" />);

        Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scroll });
        Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => rectAt(20) });

        try {
            act(() => {
                globalThis.dispatchEvent(new CustomEvent(ASIDE_FIND_EVENT));
            });
            fireEvent.change(screen.getByRole("textbox", { name: "Find in side questions" }), { target: { value: "cat" } });
            fireEvent.click(screen.getByRole("button", { name: "Next match" }));
            await settleReveal();

            // An earlier entry gains a hit above the selected one, which moves the selection to third of four.
            act(() => {
                useAsideStore.setState({
                    byThread: { "thread-1": [{ answer: "A cat too.", id: "z", question: "Above?", status: "answered", token: "tok-z" }, b, c, d] },
                });
            });
            await settleReveal();
            expect(within(screen.getByRole("search")).getByRole("status").textContent).toBe("3 of 4");
            scroll.mockClear();

            // The selected entry is dismissed. The hit that follows it takes its place, not the one at its old index.
            act(() => {
                useAsideStore.setState({
                    byThread: { "thread-1": [{ answer: "A cat too.", id: "z", question: "Above?", status: "answered", token: "tok-z" }, b, d] },
                });
            });
            await settleReveal();
            expect(within(screen.getByRole("search")).getByRole("status").textContent).toBe("3 of 3");
            expect(scroll).not.toHaveBeenCalled();
        } finally {
            Reflect.deleteProperty(Element.prototype, "scrollIntoView");
            Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
            vi.useRealTimers();
        }
    });
});
