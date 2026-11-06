/**
 * "Copy prompt link" names the model the composer shows: a bot chat's current model, an anonymous text chat's free model,
 * else the chat's own. A link the composer cannot honour is not copied, and a refused clipboard write is reported.
 */
import { ANONYMOUS_FREE_MODEL, DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { MODEL_REGISTRY } from "@neore/ai/models";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FC, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useModelStore } from "@/features/chat/core/stores/model-store";

import CopyPromptLinkAction from "./copy-prompt-link-action";

const harness = vi.hoisted(() => {
    return {
        bots: [] as { _id: string; model: string }[],
        isAnonymous: false,
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
            return { isAnonymous: harness.isAnonymous, model: harness.threadModel, thread: harness.thread, threadId: "thread-1" };
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

/** Clicks the rendered "Copy prompt link" control, as a person does. */
const clickCopy = (): void => {
    fireEvent.click(screen.getByRole("button", { name: "Copy prompt link" }));
};

const writeText = vi.fn<(text: string) => Promise<void>>();

/** The link the clipboard received, read back through the URL the way the route reads it. */
const copiedLink = (): URL => new URL(writeText.mock.calls[0]?.[0] ?? "");

describe("CopyPromptLinkAction", () => {
    beforeEach(() => {
        writeText.mockReset();
        writeText.mockResolvedValue(undefined);
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
        harness.showError.mockReset();
        harness.showSuccess.mockReset();
        harness.showWarning.mockReset();
        harness.bots = [];
        harness.isAnonymous = false;
        harness.thread = { botId: null };
        harness.threadModel = DEFAULT_CHAT_MODEL;
        useModelStore.setState({ newThreadMode: "text", threadModes: new Map() });
    });

    it("names the chat's own model when the chat is not a bot chat", async () => {
        renderAction();

        clickCopy();

        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

        expect(copiedLink().pathname).toBe("/chat");
        expect(copiedLink().searchParams.get("prompt")).toBe("Summarise this");
        expect(copiedLink().searchParams.get("model")).toBe(DEFAULT_CHAT_MODEL);
        expect(harness.showSuccess).toHaveBeenCalledWith("Prompt link copied");
    });

    it("names the bot's current model in a bot chat, not the model the thread saved", async () => {
        expect(textModel).toBeDefined();

        harness.thread = { botId: "bot-1" };
        harness.threadModel = DEFAULT_CHAT_MODEL;
        harness.bots = [{ _id: "bot-1", model: textModel?.id ?? "" }];

        renderAction(harness.bots);

        clickCopy();

        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

        expect(copiedLink().searchParams.get("model")).toBe(textModel?.id);
    });

    it("names the free model on an anonymous text chat, whatever model the thread stores, as the composer shows", async () => {
        harness.isAnonymous = true;
        harness.threadModel = textModel?.id ?? DEFAULT_CHAT_MODEL;

        expect(textModel?.id).not.toBe(ANONYMOUS_FREE_MODEL);

        renderAction();

        clickCopy();

        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

        expect(copiedLink().searchParams.get("model")).toBe(ANONYMOUS_FREE_MODEL);
    });

    it("keeps the thread's own model for an anonymous person in image mode, as the composer does", async () => {
        harness.isAnonymous = true;
        harness.threadModel = DEFAULT_CHAT_MODEL;
        useModelStore.setState({ threadModes: new Map([["thread-1", "image"]]) });

        renderAction();

        clickCopy();

        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

        expect(copiedLink().searchParams.get("model")).toBe(DEFAULT_CHAT_MODEL);
    });

    it("refuses a link for a custom endpoint's model, with a notice, rather than opening it on another model", async () => {
        harness.threadModel = "custom:ollama/llama3.1:8b";

        renderAction();

        clickCopy();

        await waitFor(() => expect(harness.showWarning).toHaveBeenCalledTimes(1));
        expect(writeText).not.toHaveBeenCalled();
        expect(harness.showSuccess).not.toHaveBeenCalled();
    });

    it("reports a refused clipboard write", async () => {
        writeText.mockRejectedValue(new Error("denied"));

        renderAction();

        clickCopy();

        await waitFor(() => expect(harness.showError).toHaveBeenCalledTimes(1));
        expect(harness.showSuccess).not.toHaveBeenCalled();
    });

    it("reports a clipboard that throws synchronously, as a browser without the Clipboard API does", async () => {
        writeText.mockImplementation(() => {
            throw new TypeError("clipboard is not available");
        });

        renderAction();

        clickCopy();

        await waitFor(() => expect(harness.showError).toHaveBeenCalledTimes(1));
        expect(harness.showSuccess).not.toHaveBeenCalled();
    });
});
