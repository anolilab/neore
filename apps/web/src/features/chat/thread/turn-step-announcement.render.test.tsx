// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import TurnStepAnnouncement from "./turn-step-announcement";

const chat = vi.hoisted(() => {
    return {
        isStreaming: false,
        messages: [] as unknown[],
        messagesReady: true,
        // Overrides this thread's own streaming flag; unset means it follows `isStreaming`.
        threadStreaming: undefined as boolean | undefined,
        threadId: "thread-1",
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});
vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatMessages: () => {
            return { isStreaming: chat.isStreaming, messages: chat.messages, messagesReady: chat.messagesReady };
        },
        useChatIsStreaming: () => {
            return { isThreadStreaming: chat.threadStreaming ?? chat.isStreaming };
        },
        useChatThread: () => {
            return { threadId: chat.threadId };
        },
    };
});

const prompt = { id: "u1", parts: [{ text: "go", type: "text" }], role: "user" };
const reply = (id: string, status: string, toolCallIds: string[], type = "tool-search") => {
    return {
        id,
        parts: toolCallIds.map((toolCallId) => {
            return { state: "input-available", toolCallId, type };
        }),
        role: "assistant",
        status,
    };
};

const region = () => screen.getByRole("status");

/** Lets the announcement's two timers run, the clear and then the text. */
const settle = () => {
    act(() => {
        vi.advanceTimersByTime(100);
    });
};

describe("turn step announcement", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        chat.threadId = "thread-1";
        chat.isStreaming = false;
        chat.messages = [prompt];
        chat.messagesReady = true;
        chat.threadStreaming = undefined;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("is a polite status region that starts empty", () => {
        render(<TurnStepAnnouncement />);

        expect(region().getAttribute("aria-live")).toBe("polite");
        expect(region().textContent).toBe("");
    });

    it("announces a tool step once when the reply starts it", () => {
        const view = render(<TurnStepAnnouncement />);

        chat.messages = [prompt, reply("r1", "streaming", ["c1"])];
        view.rerender(<TurnStepAnnouncement />);
        settle();
        expect(region().textContent).toBe("Using search");

        view.rerender(<TurnStepAnnouncement />);
        settle();
        expect(region().textContent).toBe("Using search");
    });

    it("announces a repeated tool name again, as a change the reader hears", () => {
        const view = render(<TurnStepAnnouncement />);

        chat.messages = [prompt, reply("r1", "streaming", ["c1"])];
        view.rerender(<TurnStepAnnouncement />);
        settle();

        chat.messages = [prompt, reply("r1", "streaming", ["c1", "c2"])];
        view.rerender(<TurnStepAnnouncement />);
        act(() => {
            vi.advanceTimersByTime(0);
        });
        expect(region().textContent).toBe("");
        settle();
        expect(region().textContent).toBe("Using search");
    });

    it("says the name the backend gave an MCP call", () => {
        const view = render(<TurnStepAnnouncement />);

        chat.messages = [
            prompt,
            {
                id: "r1",
                parts: [
                    {
                        callProviderMetadata: { neore: { mcpServerName: "Docs", mcpToolName: "Search pages" } },
                        state: "input-available",
                        toolCallId: "c1",
                        type: "tool-mcp_docs__search_pages",
                    },
                ],
                role: "assistant",
                status: "streaming",
            },
        ];
        view.rerender(<TurnStepAnnouncement />);
        settle();

        expect(region().textContent).toBe("Using Search pages");
    });

    it("stays silent for calls that were already running when it mounted", () => {
        chat.messages = [prompt, reply("r1", "streaming", ["c0"])];
        const view = render(<TurnStepAnnouncement />);

        view.rerender(<TurnStepAnnouncement />);
        settle();

        expect(region().textContent).toBe("");
    });

    it("stays silent for history, which is never in flight", () => {
        const view = render(<TurnStepAnnouncement />);

        chat.messages = [prompt, reply("r1", "success", ["c9"])];
        view.rerender(<TurnStepAnnouncement />);
        settle();

        expect(region().textContent).toBe("");
    });

    it("takes the calls in a list that loads after mount as the baseline, not news", () => {
        chat.messagesReady = false;
        chat.messages = [];
        const view = render(<TurnStepAnnouncement />);

        chat.messages = [prompt, reply("r1", "streaming", ["c0"])];
        view.rerender(<TurnStepAnnouncement />);
        settle();
        expect(region().textContent).toBe("");

        chat.messagesReady = true;
        view.rerender(<TurnStepAnnouncement />);
        settle();
        expect(region().textContent).toBe("");

        chat.messages = [prompt, reply("r1", "streaming", ["c0", "c1"])];
        view.rerender(<TurnStepAnnouncement />);
        settle();
        expect(region().textContent).toBe("Using search");
    });

    it("treats the calls present at a thread switch as the new baseline", () => {
        const view = render(<TurnStepAnnouncement />);

        chat.threadId = "thread-2";
        chat.messages = [prompt, reply("r5", "streaming", ["c5"])];
        view.rerender(<TurnStepAnnouncement />);
        settle();

        expect(region().textContent).toBe("");
    });

    it("lets a step that follows within the hold reach the region after the first, not in its place", () => {
        const view = render(<TurnStepAnnouncement />);

        chat.messages = [prompt, reply("r1", "streaming", ["c1"])];
        view.rerender(<TurnStepAnnouncement />);
        act(() => {
            vi.advanceTimersByTime(10);
        });

        chat.messages = [prompt, reply("r1", "streaming", ["c1", "c2"], "tool-fetch")];
        view.rerender(<TurnStepAnnouncement />);
        act(() => {
            vi.advanceTimersByTime(40);
        });
        expect(region().textContent).toBe("Using search");

        // The first label is held for the rest of its beat, then cleared, then the second is set.
        act(() => {
            vi.advanceTimersByTime(50);
        });
        expect(region().textContent).toBe("");

        act(() => {
            vi.advanceTimersByTime(50);
        });
        expect(region().textContent).toBe("Using fetch");
    });

    it("says two identical steps started close together as two changes", () => {
        const view = render(<TurnStepAnnouncement />);

        chat.messages = [prompt, reply("r1", "streaming", ["c1"])];
        view.rerender(<TurnStepAnnouncement />);
        act(() => {
            vi.advanceTimersByTime(10);
        });

        chat.messages = [prompt, reply("r1", "streaming", ["c1", "c2"])];
        view.rerender(<TurnStepAnnouncement />);
        act(() => {
            vi.advanceTimersByTime(50);
        });
        expect(region().textContent).toBe("Using search");

        act(() => {
            vi.advanceTimersByTime(50);
        });
        expect(region().textContent).toBe("");

        act(() => {
            vi.advanceTimersByTime(50);
        });
        expect(region().textContent).toBe("Using search");
    });

    it("drops a step still waiting to speak when the reply finishes", () => {
        const view = render(<TurnStepAnnouncement />);

        chat.isStreaming = true;
        chat.messages = [prompt, reply("r1", "streaming", ["c1"])];
        view.rerender(<TurnStepAnnouncement />);
        act(() => {
            vi.advanceTimersByTime(10);
        });

        chat.isStreaming = false;
        chat.messages = [prompt, reply("r1", "success", ["c1"])];
        view.rerender(<TurnStepAnnouncement />);
        settle();

        expect(region().textContent).toBe("");
    });

    it("clears the label already said once the reply finishes", () => {
        const view = render(<TurnStepAnnouncement />);

        chat.isStreaming = true;
        chat.messages = [prompt, reply("r1", "streaming", ["c1"])];
        view.rerender(<TurnStepAnnouncement />);
        settle();
        expect(region().textContent).toBe("Using search");

        chat.isStreaming = false;
        chat.messages = [prompt, reply("r1", "success", ["c1"])];
        view.rerender(<TurnStepAnnouncement />);
        settle();

        expect(region().textContent).toBe("");
    });

    it("does not say the previous turn's call when a new prompt starts streaming", () => {
        const view = render(<TurnStepAnnouncement />);

        chat.messages = [prompt, reply("r1", "success", ["c1"])];
        view.rerender(<TurnStepAnnouncement />);
        settle();

        chat.isStreaming = true;
        chat.messages = [prompt, reply("r1", "success", ["c1"]), { ...prompt, id: "u2" }];
        view.rerender(<TurnStepAnnouncement />);
        settle();

        expect(region().textContent).toBe("");
    });

    it("drops a label still waiting to speak when the thread changes", () => {
        const view = render(<TurnStepAnnouncement />);

        chat.messages = [prompt, reply("r1", "streaming", ["c1"])];
        view.rerender(<TurnStepAnnouncement />);
        act(() => {
            vi.advanceTimersByTime(10);
        });

        chat.threadId = "thread-2";
        chat.messages = [prompt];
        view.rerender(<TurnStepAnnouncement />);
        settle();

        expect(region().textContent).toBe("");
    });

    it("does not say a step again when the streamed row is swapped for the saved one", () => {
        const view = render(<TurnStepAnnouncement />);

        chat.messages = [prompt, reply("stream:r1", "streaming", ["c1"])];
        view.rerender(<TurnStepAnnouncement />);
        settle();
        expect(region().textContent).toBe("Using search");

        chat.messages = [prompt, reply("db-r1", "streaming", ["c1"])];
        view.rerender(<TurnStepAnnouncement />);
        act(() => {
            vi.advanceTimersByTime(0);
        });
        expect(region().textContent).toBe("Using search");
    });

    it("does not show a label said in the previous thread", () => {
        const view = render(<TurnStepAnnouncement />);

        chat.messages = [prompt, reply("r1", "streaming", ["c1"])];
        view.rerender(<TurnStepAnnouncement />);
        settle();
        expect(region().textContent).toBe("Using search");

        chat.threadId = "thread-2";
        chat.messages = [prompt];
        view.rerender(<TurnStepAnnouncement />);

        expect(region().textContent).toBe("");
    });

    it("does not bring back a label said in a thread once the reader has left it", () => {
        const view = render(<TurnStepAnnouncement />);

        chat.messages = [prompt, reply("r1", "streaming", ["c1"])];
        view.rerender(<TurnStepAnnouncement />);
        settle();
        expect(region().textContent).toBe("Using search");

        chat.threadId = "thread-2";
        chat.messages = [prompt];
        view.rerender(<TurnStepAnnouncement />);

        chat.threadId = "thread-1";
        chat.messages = [prompt, reply("r1", "success", ["c1"])];
        view.rerender(<TurnStepAnnouncement />);

        expect(region().textContent).toBe("");
    });

    it("says a call whose id a later reply reuses", () => {
        const view = render(<TurnStepAnnouncement />);

        chat.messages = [prompt, reply("r1", "streaming", ["c1"])];
        view.rerender(<TurnStepAnnouncement />);
        settle();
        expect(region().textContent).toBe("Using search");

        const nextPrompt = { ...prompt, id: "u2" };

        chat.messages = [prompt, reply("r1", "success", ["c1"]), nextPrompt, reply("r2", "streaming", ["c1"])];
        view.rerender(<TurnStepAnnouncement />);
        act(() => {
            vi.advanceTimersByTime(0);
        });
        expect(region().textContent).toBe("");
        settle();
        expect(region().textContent).toBe("Using search");
    });

    it("says a step that finished before the reader saw it, while the turn still streams", () => {
        const view = render(<TurnStepAnnouncement />);

        chat.isStreaming = true;
        chat.messages = [prompt, reply("r1", "success", ["c1"])];
        view.rerender(<TurnStepAnnouncement />);
        settle();

        expect(region().textContent).toBe("Using search");
    });

    it("says a dynamic-tool call by its name", () => {
        const view = render(<TurnStepAnnouncement />);

        chat.messages = [
            prompt,
            {
                id: "r1",
                parts: [{ state: "input-available", toolCallId: "c1", toolName: "search_pages", type: "dynamic-tool" }],
                role: "assistant",
                status: "streaming",
            },
        ];
        view.rerender(<TurnStepAnnouncement />);
        settle();

        expect(region().textContent).toBe("Using search_pages");
    });

    it("stays silent for a settled reply here while another chat streams", () => {
        const view = render(<TurnStepAnnouncement />);

        chat.isStreaming = true;
        chat.threadStreaming = false;
        chat.messages = [prompt, reply("r1", "success", ["c1"]), { ...prompt, id: "u2" }, reply("r2", "success", ["c2"])];
        view.rerender(<TurnStepAnnouncement />);
        settle();

        expect(region().textContent).toBe("");
    });
});
