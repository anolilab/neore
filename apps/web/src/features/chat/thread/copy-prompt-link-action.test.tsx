/**
 * "Copy prompt link" names the model the composer shows: a bot chat's current model, an anonymous text chat's free model,
 * else the chat's own. A link the composer cannot honour is not copied, and a refused clipboard write is reported.
 */
import { ANONYMOUS_FREE_MODEL, DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { MODEL_REGISTRY } from "@neore/ai/models";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { defaultParseSearch } from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FC, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useModelStore } from "@/features/chat/core/stores/model-store";

import CopyPromptLinkAction from "./copy-prompt-link-action";

const harness = vi.hoisted(() => {
    return {
        bots: [] as { _id: string; model: string }[],
        /** The bot list the click reads: the default answers at once with `bots`; a test replaces it to hold or fail the read. */
        loadBots: (): Promise<{ _id: string; model: string }[]> => Promise.resolve([]),
        isAnonymous: false,
        showError: vi.fn(),
        showSuccess: vi.fn(),
        showWarning: vi.fn(),
        composerModelEntries: undefined as ReadonlyMap<string, { id: string; mode?: string; provider?: string }> | undefined,
        thread: { activeAgent: undefined, autoModel: false, botId: null as string | null } as {
            activeAgent?: unknown;
            autoModel?: boolean;
            botId: string | null;
        } | null,
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
            return {
                composerModelEntries: harness.composerModelEntries,
                isAnonymous: harness.isAnonymous,
                model: harness.threadModel,
                thread: harness.thread,
                threadId: "thread-1",
            };
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
                                // A one-shot read (`live: false`) never goes stale on its own: a cached list is reused until refetched.
                                return { queryFn: () => harness.loadBots(), queryKey: ["listBots"], staleTime: Infinity };
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

const messageOf = (text: string) => ({ id: "message-1", parts: [{ text, type: "text" }], role: "user", text }) as never;

const textModels = MODEL_REGISTRY.filter((model) => (model.mode ?? "text") === "text" && model.enabled !== false && model.provider !== "external");
const [textModel, otherTextModel] = textModels;
const imageModel = MODEL_REGISTRY.find((model) => model.mode === "image" && model.enabled !== false);

const renderAction = (cachedBots?: { _id: string; model: string }[], text = "Summarise this"): void => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Wrapper: FC<{ children: ReactNode }> = ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

    // The bot list is also in the shared cache, as the composer reads it: seeded before the first click.
    if (cachedBots) {
        client.setQueryData(["listBots"], cachedBots);
    }

    render(<CopyPromptLinkAction message={messageOf(text)} />, { wrapper: Wrapper });
};

/**
 * Clicks the rendered "Copy prompt link" control with the events a person's click produces: the pointer and mouse go down, the
 * control takes focus, then the pointer and mouse go up and the click fires. Those are the events a click dispatches in a
 * browser; this does not use the user-event library, which this repository does not depend on.
 */
const clickCopy = (): void => {
    const button = screen.getByRole("button", { name: "Copy prompt link" });

    fireEvent.pointerDown(button);
    fireEvent.mouseDown(button);
    act(() => {
        button.focus();
    });
    fireEvent.pointerUp(button);
    fireEvent.mouseUp(button);
    fireEvent.click(button);
};

/** Stands in for the ResizeObserver that the tooltip positions itself with; the environment's own stand-in is not constructible. */
function ResizeObserverStub() {
    return { disconnect: () => undefined, observe: () => undefined, unobserve: () => undefined };
}

const writeText = vi.fn<(text: string) => Promise<void>>();

/** The link the clipboard received, read back through the URL the way the route reads it. */
const copiedLink = (): URL => new URL(writeText.mock.calls[0]?.[0] ?? "");

/** The prompt the copied link opens, as the route reads it (the router parses the query). */
const routePrompt = (): unknown => (defaultParseSearch(copiedLink().search) as { prompt?: unknown }).prompt;

/** A ClipboardItem as a browser that has one: its values are read when the write runs, so a pending value is allowed. */
class FakeClipboardItem {
    readonly items: Record<string, Promise<Blob>>;

    constructor(items: Record<string, Promise<Blob>>) {
        this.items = items;
    }
}

describe("CopyPromptLinkAction", () => {
    beforeEach(() => {
        // Focus opens the control's tooltip, which positions itself with a ResizeObserver: the environment's stand-in is not constructible.
        vi.stubGlobal("ResizeObserver", vi.fn(ResizeObserverStub));
        writeText.mockReset();
        writeText.mockResolvedValue(undefined);
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
        harness.showError.mockReset();
        harness.showSuccess.mockReset();
        harness.showWarning.mockReset();
        harness.bots = [];
        harness.loadBots = () => Promise.resolve(harness.bots);
        harness.isAnonymous = false;
        harness.thread = { botId: null };
        harness.threadModel = DEFAULT_CHAT_MODEL;
        useModelStore.setState({
            comparisonMode: false,
            newThreadMode: "text",
            selectedModelsForComparison: [],
            threadModes: new Map(),
        });
        // The composer offers every text model by default, so a copy of any of them is one the open would select.
        harness.composerModelEntries = new Map(textModels.map((model) => [model.id, { id: model.id, mode: model.mode, provider: model.provider }]));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("names the chat's own model when the chat is not a bot chat", async () => {
        renderAction();

        clickCopy();

        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

        expect(copiedLink().pathname).toBe("/chat");
        expect(routePrompt()).toBe("Summarise this");
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

    it("names the bot's model from a fresh read, not a cached list that predates a model change", async () => {
        expect(textModel).toBeDefined();
        expect(otherTextModel).toBeDefined();

        harness.thread = { botId: "bot-1" };
        harness.threadModel = DEFAULT_CHAT_MODEL;
        harness.bots = [{ _id: "bot-1", model: otherTextModel?.id ?? "" }];

        renderAction([{ _id: "bot-1", model: textModel?.id ?? "" }]);

        clickCopy();

        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

        expect(copiedLink().searchParams.get("model")).toBe(otherTextModel?.id);
    });

    it("starts the clipboard write on the click, before a bot list that has not answered", async () => {
        const write = vi.fn(async (items: FakeClipboardItem[]) => {
            await Promise.all(items.map(async (item) => await item.items["text/plain"]));
        });
        let answerBots: (() => void) | undefined;

        vi.stubGlobal("ClipboardItem", FakeClipboardItem);
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write, writeText } });

        harness.thread = { botId: "bot-1" };
        harness.bots = [{ _id: "bot-1", model: textModel?.id ?? "" }];
        harness.loadBots = () =>
            new Promise((resolve) => {
                answerBots = () => resolve(harness.bots);
            });

        renderAction();

        clickCopy();

        // The write is already in flight: nothing has been awaited before it started.
        expect(write).toHaveBeenCalledTimes(1);

        answerBots?.();

        await waitFor(() => expect(harness.showSuccess).toHaveBeenCalledWith("Prompt link copied"));

        const item = write.mock.calls[0]?.[0][0];
        const blob = await item?.items["text/plain"];
        const text = await blob?.text();

        expect(new URL(text ?? "").searchParams.get("model")).toBe(textModel?.id);
        expect(writeText).not.toHaveBeenCalled();
    });

    it("reports a failed bot-list read and copies nothing, rather than naming the stored model", async () => {
        harness.thread = { botId: "bot-1" };
        harness.threadModel = DEFAULT_CHAT_MODEL;
        harness.loadBots = () => Promise.reject(new Error("offline"));

        renderAction();

        clickCopy();

        await waitFor(() => expect(harness.showError).toHaveBeenCalledWith("Could not read this chat's bot, so no link was copied."));
        expect(harness.showError).toHaveBeenCalledTimes(1);
        expect(writeText).not.toHaveBeenCalled();
        expect(harness.showSuccess).not.toHaveBeenCalled();
    });

    it("refuses a failed bot-list read on a browser with ClipboardItem too: the write is started, rejected, and says why", async () => {
        const write = vi.fn(async (items: FakeClipboardItem[]) => {
            await Promise.all(items.map(async (item) => await item.items["text/plain"]));
        });

        vi.stubGlobal("ClipboardItem", FakeClipboardItem);
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write, writeText } });

        harness.thread = { botId: "bot-1" };
        harness.loadBots = () => Promise.reject(new Error("offline"));

        renderAction();

        clickCopy();

        await waitFor(() => expect(harness.showError).toHaveBeenCalledWith("Could not read this chat's bot, so no link was copied."));
        expect(write).toHaveBeenCalledTimes(1);
        expect(writeText).not.toHaveBeenCalled();
        expect(harness.showSuccess).not.toHaveBeenCalled();
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

    it("refuses to copy in image mode, where the composer sends its image model, with the warning, and copies nothing", async () => {
        expect(imageModel).toBeDefined();

        harness.threadModel = imageModel?.id ?? "";
        useModelStore.setState({ threadModes: new Map([["thread-1", "image"]]) });

        renderAction();

        clickCopy();

        await waitFor(() => expect(harness.showWarning).toHaveBeenCalledWith("A prompt link cannot name this chat's model, so no link was copied."));
        expect(writeText).not.toHaveBeenCalled();
        expect(harness.showSuccess).not.toHaveBeenCalled();
    });

    it("a message whose only content is hidden, with no visible text, shows the no-text notice and writes nothing to the clipboard", async () => {
        renderAction(undefined, "\u{E0041}\u{E0042}\u{202E}");

        clickCopy();

        await waitFor(() => expect(harness.showWarning).toHaveBeenCalledWith("This message has no text to copy as a prompt link."));
        expect(writeText).not.toHaveBeenCalled();
        expect(harness.showSuccess).not.toHaveBeenCalled();
    });

    it("refuses a link for a custom endpoint's model, with a notice, rather than opening it on another model", async () => {
        harness.threadModel = "custom:ollama/llama3.1:8b";

        renderAction();

        clickCopy();

        await waitFor(() => expect(harness.showWarning).toHaveBeenCalledTimes(1));
        expect(writeText).not.toHaveBeenCalled();
        expect(harness.showSuccess).not.toHaveBeenCalled();
    });

    it("refuses a long non-Latin message whose encoded link would not open, with the warning, and copies nothing", async () => {
        renderAction(undefined, "漢".repeat(2000));

        clickCopy();

        await waitFor(() => expect(harness.showWarning).toHaveBeenCalledWith("This message is too long to copy as a prompt link."));
        expect(writeText).not.toHaveBeenCalled();
        expect(harness.showSuccess).not.toHaveBeenCalled();
    });

    it("copies a long non-Latin message under the limit, and the copied link opens it whole", async () => {
        const text = "漢".repeat(800);

        renderAction(undefined, text);

        clickCopy();

        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
        expect(routePrompt()).toBe(text);
    });

    it("refuses that same long message in a bot chat with the same sentence, as an error, and copies nothing", async () => {
        harness.thread = { botId: "bot-1" };
        harness.bots = [{ _id: "bot-1", model: textModel?.id ?? "" }];

        renderAction(harness.bots, "漢".repeat(2000));

        clickCopy();

        await waitFor(() => expect(harness.showError).toHaveBeenCalledWith("This message is too long to copy as a prompt link."));
        expect(writeText).not.toHaveBeenCalled();
    });

    it("names the model notice, not the generic copy error, when a bot's model cannot go in a link", async () => {
        expect(imageModel).toBeDefined();

        harness.thread = { botId: "bot-1" };
        harness.bots = [{ _id: "bot-1", model: imageModel?.id ?? "" }];

        renderAction(harness.bots);

        clickCopy();

        await waitFor(() => expect(harness.showError).toHaveBeenCalledWith("A prompt link cannot name this chat's model, so no link was copied."));
        expect(harness.showError).not.toHaveBeenCalledWith("Could not copy the link");
        expect(writeText).not.toHaveBeenCalled();
    });

    it("refuses to copy in comparison mode, where the composer sends to several models, and copies nothing", async () => {
        expect(textModel).toBeDefined();
        expect(otherTextModel).toBeDefined();

        useModelStore.setState({ comparisonMode: true, selectedModelsForComparison: [textModel?.id ?? "", otherTextModel?.id ?? ""] as never });

        renderAction();

        clickCopy();

        await waitFor(() =>
            expect(harness.showWarning).toHaveBeenCalledWith("This chat sends to several models, and a prompt link names one, so no link was copied."),
        );
        expect(writeText).not.toHaveBeenCalled();
        expect(harness.showSuccess).not.toHaveBeenCalled();
    });

    it("copies normally with comparison mode on but only one model selected, as the composer sends that as a single send", async () => {
        useModelStore.setState({ comparisonMode: true, selectedModelsForComparison: [textModel?.id ?? ""] as never });

        renderAction();

        clickCopy();

        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
        expect(copiedLink().searchParams.get("model")).toBe(DEFAULT_CHAT_MODEL);
    });

    it("refuses a copy whose model the composer no longer offers, so the open never selects a different model", async () => {
        expect(textModel).toBeDefined();

        // The thread's model is one the user has since blocked: the picker does not offer it, and the open would not select it.
        harness.threadModel = textModel?.id ?? "";
        harness.composerModelEntries = new Map([[DEFAULT_CHAT_MODEL, { id: DEFAULT_CHAT_MODEL }]]);

        renderAction();

        clickCopy();

        await waitFor(() => expect(harness.showWarning).toHaveBeenCalledWith("A prompt link cannot name this chat's model, so no link was copied."));
        expect(writeText).not.toHaveBeenCalled();
    });

    it("copies from a text thread after an image chat, since the link opens a text chat whatever mode the composer was last in", async () => {
        // The composer was last in image mode for a new chat. The copy names the thread's own text model, and the open sets a text chat.
        useModelStore.setState({ newThreadMode: "image" });
        harness.threadModel = DEFAULT_CHAT_MODEL;

        renderAction();

        clickCopy();

        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
        expect(copiedLink().searchParams.get("model")).toBe(DEFAULT_CHAT_MODEL);
        expect(harness.showWarning).not.toHaveBeenCalled();
    });

    it("refuses a copy in a chat that Auto routes, since Auto picks the model for each send, and copies nothing", async () => {
        harness.thread = { activeAgent: undefined, autoModel: true, botId: null };

        renderAction();

        clickCopy();

        await waitFor(() =>
            expect(harness.showWarning).toHaveBeenCalledWith("Auto chooses the model for each send, so a prompt link cannot name one, and no link was copied."),
        );
        expect(writeText).not.toHaveBeenCalled();
    });

    it("copies from a chat whose Auto is off, as it does for a thread that has an active model", async () => {
        harness.thread = { activeAgent: { kind: "model", model: DEFAULT_CHAT_MODEL }, autoModel: true, botId: null };
        harness.threadModel = DEFAULT_CHAT_MODEL;

        renderAction();

        clickCopy();

        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
        expect(harness.showWarning).not.toHaveBeenCalled();
    });

    it("refuses a copy while the composer's model list is still loading, rather than copy a model it may not offer", async () => {
        harness.composerModelEntries = undefined;

        renderAction();

        clickCopy();

        await waitFor(() =>
            expect(harness.showWarning).toHaveBeenCalledWith("Your model settings are still loading, so no link was copied. Try again in a moment."),
        );
        expect(writeText).not.toHaveBeenCalled();
    });

    it("refuses a bot chat's copy when the bot's model is one the composer no longer offers, with the same sentence", async () => {
        expect(textModel).toBeDefined();

        harness.thread = { botId: "bot-1" };
        harness.bots = [{ _id: "bot-1", model: textModel?.id ?? "" }];
        harness.composerModelEntries = new Map([[DEFAULT_CHAT_MODEL, { id: DEFAULT_CHAT_MODEL }]]);

        renderAction(harness.bots);

        clickCopy();

        await waitFor(() => expect(harness.showError).toHaveBeenCalledWith("A prompt link cannot name this chat's model, so no link was copied."));
        expect(writeText).not.toHaveBeenCalled();
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
