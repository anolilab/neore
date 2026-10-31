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
        askAside.mockResolvedValue({ answer: "It is safe to repeat.", withThread: true });
        render(<AsidePanel threadId="thread-1" />);

        expect(screen.getByRole("region", { name: "Side question" })).toBeTruthy();
        ask("What is idempotent?");

        const live = screen.getByRole("status");

        expect(live.getAttribute("aria-live")).toBe("polite");
        expect(live.textContent).toBe("Thinking…");
        await waitFor(() => expect(live.textContent).toBe("It is safe to repeat."));
        expect(askAside).toHaveBeenCalledWith({ question: "What is idempotent?", threadId: "thread-1", unlockProof: undefined });
    });

    it("works while a reply streams, but adds to the thread only once it has finished", async () => {
        chat.isRunning = true;
        askAside.mockResolvedValue({ answer: "Because.", withThread: true });
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
        expect(addAside).toHaveBeenCalledWith({ answer: "Because.", question: "Why?", threadId: "thread-1", unlockProof: undefined });
    });

    it("says so when the quota is used up", async () => {
        askAside.mockRejectedValue({ data: { code: "TOO_MANY_REQUESTS" } });
        render(<AsidePanel threadId="thread-1" />);

        ask("Again?");

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toContain("used today's messages");
    });

    it("asks for a conversation first when there is no thread", () => {
        render(<AsidePanel />);

        expect(screen.getByText("Start a conversation to ask a side question.")).toBeTruthy();
        expect(screen.queryByLabelText("Your side question")).toBeNull();
    });
});
