/**
 * "Copy prompt link" names the model the composer shows: a bot chat's current model, else the chat's own. A refused
 * clipboard write, including one that throws, is reported.
 */
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { MODEL_REGISTRY } from "@neore/ai/models";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FC, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import CopyPromptLinkAction from "./copy-prompt-link-action";

const harness = vi.hoisted(() => {
    return {
        bots: [] as { _id: string; model: string }[],
        showError: vi.fn(),
        showSuccess: vi.fn(),
        showWarning: vi.fn(),
        thread: { botId: null as string | null } as { botId: string | null } | null,
        threadModel: "" as string,
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatThread: () => {
            return { model: harness.threadModel, thread: harness.thread, threadId: "thread-1" };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                bots: {
                    functions: {
                        listBots: {
                            queryOptions: () => {
                                return { queryFn: () => harness.bots, queryKey: ["listBots"] };
                            },
                        },
                    },
                },
            };
        },
    };
});

vi.mock("@/lib/toast", () => {
    return {
        showError: (error: unknown) => harness.showError(error),
        showSuccess: (message: unknown) => harness.showSuccess(message),
        showWarning: (message: unknown) => harness.showWarning(message),
    };
});

vi.mock("@neore/ui/components/ai-elements/message", () => {
    return {
        MessageAction: ({ children, label, onClick }: { children: ReactNode; label: string; onClick: () => void }) => (
            <button aria-label={label} onClick={onClick} type="button">
                {children}
            </button>
        ),
    };
});

const message = { id: "message-1", parts: [{ text: "Summarise this", type: "text" }], role: "user", text: "Summarise this" } as never;

const textModel = MODEL_REGISTRY.find((model) => (model.mode ?? "text") === "text" && model.enabled !== false && model.provider !== "external");

const renderAction = (cachedBots?: { _id: string; model: string }[]): void => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Wrapper: FC<{ children: ReactNode }> = ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

    // The bot list is read from the shared cache, as the composer reads it: seeded before the first click.
    if (cachedBots) {
        client.setQueryData(["listBots"], cachedBots);
    }

    render(<CopyPromptLinkAction message={message} />, { wrapper: Wrapper });
};

const writeText = vi.fn<(text: string) => Promise<void>>();

describe("CopyPromptLinkAction", () => {
    beforeEach(() => {
        writeText.mockReset();
        writeText.mockResolvedValue(undefined);
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
        harness.showError.mockReset();
        harness.showSuccess.mockReset();
        harness.showWarning.mockReset();
        harness.bots = [];
        harness.thread = { botId: null };
        harness.threadModel = DEFAULT_CHAT_MODEL;
    });

    it("names the chat's own model when the chat is not a bot chat", async () => {
        renderAction();

        fireEvent.click(screen.getByRole("button", { name: "Copy prompt link" }));

        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

        const link = new URL(writeText.mock.calls[0]?.[0] ?? "");

        expect(link.pathname).toBe("/chat");
        expect(link.searchParams.get("prompt")).toBe("Summarise this");
        expect(link.searchParams.get("model")).toBe(DEFAULT_CHAT_MODEL);
        expect(harness.showSuccess).toHaveBeenCalledWith("Prompt link copied");
    });

    it("names the bot's current model in a bot chat, not the model the thread saved", async () => {
        expect(textModel).toBeDefined();

        harness.thread = { botId: "bot-1" };
        harness.threadModel = DEFAULT_CHAT_MODEL;
        harness.bots = [{ _id: "bot-1", model: textModel?.id ?? "" }];

        renderAction(harness.bots);

        fireEvent.click(screen.getByRole("button", { name: "Copy prompt link" }));

        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

        expect(new URL(writeText.mock.calls[0]?.[0] ?? "").searchParams.get("model")).toBe(textModel?.id);
    });

    it("reports a refused clipboard write", async () => {
        writeText.mockRejectedValue(new Error("denied"));

        renderAction();

        fireEvent.click(screen.getByRole("button", { name: "Copy prompt link" }));

        await waitFor(() => expect(harness.showError).toHaveBeenCalledTimes(1));
        expect(harness.showSuccess).not.toHaveBeenCalled();
    });

    it("reports a clipboard that throws synchronously, as a browser without the Clipboard API does", async () => {
        writeText.mockImplementation(() => {
            throw new TypeError("clipboard is not available");
        });

        renderAction();

        fireEvent.click(screen.getByRole("button", { name: "Copy prompt link" }));

        await waitFor(() => expect(harness.showError).toHaveBeenCalledTimes(1));
        expect(harness.showSuccess).not.toHaveBeenCalled();
    });
});
