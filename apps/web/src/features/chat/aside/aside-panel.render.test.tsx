// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
});
