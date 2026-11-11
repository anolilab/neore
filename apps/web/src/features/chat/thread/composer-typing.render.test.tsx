/**
 * Render-count profile of typing into the composer of a long thread. The real `ComposerInput` (its input row too, with
 * the tiptap editor stubbed), the real message list, the prompt-improvement panel and sidebar rows that ask "has this
 * chat a draft?" are mounted side by side under React Profilers. Each keystroke goes in the way the editor's
 * `onUpdate` sends it: the whole draft through `onChange`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import type { Context, ProfilerOnRenderCallback, ReactNode } from "react";
import { createElement, Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { useModelStore } from "@/features/chat/core/stores/model-store";
import usePromptImprovementStore from "@/features/chat/prompt-improvement/stores/prompt-improvement-store";
import type { UIMessage } from "@/lib/agent";

const harness = vi.hoisted(() => {
    return {
        ActionsContext: undefined as Context<Record<string, unknown>> | undefined,
        contentRenders: 0,
        messages: [] as unknown[],
        onChange: undefined as ((text: string) => void) | undefined,
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        Trans: ({ children }: { children: ReactNode }) => children,
        useLingui: () => {
            return {
                i18n: { _: (descriptor: { id: string }) => descriptor.id, locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@/features/chat/core/context/chat-context", async () => {
    const { createContext, use } = await import("react");

    harness.ActionsContext = createContext<Record<string, unknown>>({});

    return {
        useChatActions: () => use(harness.ActionsContext!),
        useChatIsStreaming: () => {
            return { activeStreamId: null, gatewayUrl: null, isStreaming: false, sseStreamState: null, streamToken: null };
        },
        useChatLunora: () => {
            return {};
        },
        useChatMessages: () => {
            return { isStreaming: false, loadMore: () => {}, messages: harness.messages, messagesReady: true, messagesStatus: "Exhausted" };
        },
        useChatThread: () => {
            return { isNewThread: false, model: "test-model", thread: undefined, threadId: "thread-1" };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    // Any path (`crpc.a.b.fn.mutationOptions()`) ends in mutation options.
    const proxy: unknown = new Proxy(() => undefined, {
        apply: () => {
            return { mutationFn: async () => undefined };
        },
        get: () => proxy,
    });

    return {
        useCRPC: () => proxy,
        useLunoraActionOptions: () => {
            return { mutationFn: async () => undefined };
        },
    };
});

vi.mock("@/lib/auth/server-functions", () => {
    return { default: vi.fn() };
});

vi.mock("@/lib/env", () => {
    return { default: { VITE_LUNORA_URL: "http://localhost:8788" } };
});

vi.mock("@/features/auth/hooks/use-invite-only", () => {
    return {
        default: () => {
            return { canSignUp: true, inviteOnly: false, mustSignIn: false, signUpHref: "/auth/sign-up" };
        },
    };
});

vi.mock("@/features/auth/hooks/use-user-settings", () => {
    return {
        useUserSettings: () => {
            return { data: undefined };
        },
    };
});

vi.mock("@/features/layout/hooks/use-ui-state", () => {
    return {
        useUserPreferences: () => {
            return { sendBehavior: "enter" };
        },
    };
});

vi.mock("@/features/chat/core/hooks/use-pending-send", async (importOriginal) => {
    const original = await importOriginal<typeof import("@/features/chat/core/hooks/use-pending-send")>();

    return { ...original, default: () => undefined };
});

vi.mock("@/features/chat/core/hooks/use-comparison-chat", () => {
    return {
        default: () => {
            return { isLoading: false, sendComparisonMessage: async () => undefined };
        },
    };
});

vi.mock("@/features/chat/core/hooks/use-runner-capabilities", () => {
    return { default: () => null };
});

vi.mock("@/features/chat/core/hooks/use-thread-manager", () => {
    return {
        useThreadManager: () => {
            return { createBranch: async () => undefined };
        },
    };
});

vi.mock("@/features/chat/prompt-improvement/hooks/use-prompt-improvement", () => {
    return {
        default: () => {
            return { improvePrompt: async () => undefined, iterate: async () => undefined };
        },
    };
});

vi.mock("@/hooks/use-feature-flagged-models", () => {
    return { default: () => [] };
});

vi.mock("./use-prompt-history", async (importOriginal) => {
    const original = await importOriginal<typeof import("./use-prompt-history")>();

    return { ...original, PromptHistorySource: () => null };
});

vi.mock("./composer-tiptap/use-composer-autocomplete", () => {
    return { default: () => undefined };
});

// The editor stands in with its contract: it sends the whole draft on each change.
vi.mock("./composer-tiptap/composer-tiptap-editor", () => {
    return {
        ComposerTiptapEditor: ({ onChange }: { onChange: (text: string) => void }) => {
            harness.onChange = onChange;

            return createElement("div", { "data-testid": "editor" });
        },
    };
});

vi.mock("./message-content", () => {
    return {
        default: ({ message }: { message: UIMessage }) => {
            harness.contentRenders += 1;

            return createElement("div", null, message.text);
        },
    };
});

for (const path of [
    "@/features/chat/voice-mode/auto-read-replies",
    "@/features/chat/voice-mode/voice-mode-button",
    "@/features/chat/evals/components/save-eval-case-action",
    "@/features/evals/components/save-eval-case-action",
    "@/features/chat/translation/message-translation",
    "@/features/chat/translation/translate-action",
    "./composer-voice-input",
    "./completion-sound",
    "./composer-prompt-queue",
    "./reply-complete-announcement",
    "./host-changes-of-thread",
    "./generation-model-menu",
    "./read-aloud-action",
    "./restore-to-input-action",
    "./memory-usage-action",
    "./fork-branch-dialog",
]) {
    vi.doMock(path, () => {
        return { default: () => null };
    });
}

vi.mock("./streaming-placeholder", () => {
    return { StreamingPlaceholder: () => null, ThinkingPlaceholder: () => null };
});

vi.mock("@/features/chat/group/use-group-chat", () => {
    return { useGroupChat: () => null };
});

vi.mock("@/features/chat/goal/use-thread-goal", () => {
    return { useThreadGoal: () => null };
});

const { default: ComposerInput } = await import("./composer-input");
const { default: MessageList } = await import("./message-list");
const { default: PromptImprovementPanel } = await import("@/features/chat/prompt-improvement/components/prompt-improvement-panel");
const { default: ComposerSearchSuggestions } = await import("./composer-search-suggestions");
const { useChatHasDraft } = await import("@/features/chat/split/use-chat-has-draft");

// Enough rows to show none re-renders; 200 rows made the mount alone pass the default timeout under a full run.
const THREAD_LENGTH = 60;
const SIDEBAR_ROWS = 50;
const KEYSTROKES = 20;

const makeMessage = (index: number): UIMessage => {
    const role = index % 2 === 0 ? "user" : "assistant";
    const text = `message ${index}`;

    return {
        _creationTime: 1_700_000_000_000 + index,
        id: `m${index}`,
        key: `m${index}`,
        order: Math.floor(index / 2),
        parts: [{ text, type: "text" }],
        role,
        status: "success",
        stepOrder: role === "user" ? 0 : 1,
        text,
    } as UIMessage;
};

const SidebarRow = ({ threadId }: { threadId: string }): ReactNode => {
    const hasDraft = useChatHasDraft(threadId);

    return createElement("span", null, hasDraft ? "draft" : "");
};

const commits = new Map<string, number>();
const onRender: ProfilerOnRenderCallback = (id) => {
    commits.set(id, (commits.get(id) ?? 0) + 1);
};

const mount = (): void => {
    harness.messages = Array.from({ length: THREAD_LENGTH }, (_, index) => makeMessage(index));

    const ActionsContext = harness.ActionsContext!;
    const actions = { cancelStream: () => {}, copyMessage: () => {}, jwtToken: "", reloadMessage: () => {}, sendMessage: async () => undefined };

    render(
        <QueryClientProvider client={new QueryClient()}>
            <ActionsContext value={actions}>
                <Profiler id="sidebar" onRender={onRender}>
                    {Array.from({ length: SIDEBAR_ROWS }, (_, index) => (
                        <SidebarRow key={index} threadId={`thread-${index}`} />
                    ))}
                </Profiler>
                <Profiler id="thread" onRender={onRender}>
                    <MessageList />
                </Profiler>
                <Profiler id="improvement-panel" onRender={onRender}>
                    <PromptImprovementPanel />
                </Profiler>
                <Profiler id="search-suggestions" onRender={onRender}>
                    <ComposerSearchSuggestions />
                </Profiler>
                <Profiler id="composer" onRender={onRender}>
                    <ComposerInput />
                </Profiler>
            </ActionsContext>
        </QueryClientProvider>,
    );
};

/** Types `text` one letter at a time, as the editor's `onUpdate` sends it: the whole draft on each change. */
const type = (text: string): void => {
    for (let index = 1; index <= text.length; index += 1) {
        act(() => harness.onChange?.(text.slice(0, index)));
    }
};

describe("typing into the composer of a long thread", () => {
    beforeEach(() => {
        // A search mode, so the search suggestions are mounted as they are in the chat.
        useModelStore.setState({ searchMode: "code" });
    });

    afterEach(() => {
        useChatUIStore.getState().clearComposer();
        usePromptImprovementStore.getState().dismiss();
        useModelStore.setState({ searchMode: "chat" });
        vi.useRealTimers();
    });

    it("re-renders the composer only, never a thread row, the improvement panel, the search suggestions or a sidebar row", () => {
        mount();
        commits.clear();
        harness.contentRenders = 0;

        type("a".repeat(KEYSTROKES));

        expect(useChatUIStore.getState().composerText).toBe("a".repeat(KEYSTROKES));
        expect(harness.contentRenders).toBe(0);
        expect(commits.get("thread") ?? 0).toBe(0);
        expect(commits.get("improvement-panel") ?? 0).toBe(0);
        expect(commits.get("search-suggestions") ?? 0).toBe(0);
        // These rows are other chats: the draft is this one's.
        expect(commits.get("sidebar") ?? 0).toBe(0);
        expect(commits.get("composer")).toBeGreaterThanOrEqual(KEYSTROKES);
    });

    it("still offers search suggestions once typing pauses", () => {
        vi.useFakeTimers();
        render(<ComposerSearchSuggestions />);

        for (const draft of ["r", "ru", "rus", "rust"]) {
            act(() => useChatUIStore.getState().setComposerText(draft));
        }

        expect(screen.queryByRole("group", { name: "Search suggestions" })).toBeNull();

        act(() => vi.advanceTimersByTime(200));

        expect(screen.getByRole("button", { name: "rust example" })).toBeTruthy();
    });

    it("follows the draft in the improvement panel while it is open", () => {
        render(<PromptImprovementPanel />);
        act(() => useChatUIStore.getState().setComposerText("first"));
        act(() => usePromptImprovementStore.getState().open("first", "thread-1"));

        act(() => useChatUIStore.getState().setComposerText("first draft"));

        expect(usePromptImprovementStore.getState().currentPrompt).toBe("first draft");
    });
});
