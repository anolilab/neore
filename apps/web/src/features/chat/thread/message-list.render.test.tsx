/**
 * Render-count harness for the message list: how many rows re-render when a
 * live update touches one message of a long thread. Rows are counted through a
 * stub `MessageContent`, which every `MessageItem` render renders once.
 */

import { formatGoalReviewNote } from "@neore/backend/chat/goals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import type { Context, ReactNode } from "react";
import { createElement, useLayoutEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UIMessage } from "@/lib/agent";
import { shareUnchangedMessages } from "@/lib/agent/share-unchanged-messages";

const harness = vi.hoisted(() => {
    return {
        actions: {} as Record<string, unknown>,
        ActionsContext: undefined as Context<Record<string, unknown>> | undefined,
        contentRenders: new Map<string, number>(),
        goal: null as unknown,
        messages: [] as unknown[],
        MessagesContext: undefined as Context<unknown[]> | undefined,
        publish: undefined as (() => void) | undefined,
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        Trans: ({ children }: { children: unknown }) => children,
        useLingui: () => {
            return { i18n: { locale: "en" }, t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("@/features/chat/core/context/chat-context", async () => {
    const { createContext, use } = await import("react");

    // Two separate contexts, like ChatProvider's split messages/actions contexts.
    harness.MessagesContext = createContext<unknown[]>([]);
    harness.ActionsContext = createContext<Record<string, unknown>>({});

    return {
        useChatActions: () => use(harness.ActionsContext!),
        useChatIsStreaming: () => {
            return { activeStreamId: null, gatewayUrl: null, isStreaming: false, streamToken: null };
        },
        useChatMessages: () => {
            return { isStreaming: false, loadMore: () => {}, messages: use(harness.MessagesContext!), messagesReady: true, messagesStatus: "Exhausted" };
        },
        useChatThread: () => {
            return { isNewThread: false, model: "test-model", thread: undefined, threadId: "thread-1" };
        },
    };
});

// A host turn's changes (and the comment draft under them) are not under test here and reach for the backend.
vi.mock("./host-changes-of-thread", () => {
    return { default: () => null };
});

vi.mock("./message-content", () => {
    return {
        default: ({ message }: { message: UIMessage }) => {
            harness.contentRenders.set(message.id, (harness.contentRenders.get(message.id) ?? 0) + 1);

            return createElement("div", null, message.text);
        },
    };
});

vi.mock("./streaming-placeholder", () => {
    return { StreamingPlaceholder: () => null, ThinkingPlaceholder: () => null };
});

vi.mock("@/features/chat/core/hooks/use-thread-manager", () => {
    return {
        useThreadManager: () => {
            return { createBranch: async () => undefined };
        },
    };
});

vi.mock("@/hooks/use-feature-flagged-models", () => {
    return { default: () => [] };
});

vi.mock("@/features/auth/hooks/use-user-settings", () => {
    return {
        useUserSettings: () => {
            return { data: undefined };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    const leaf = {
        mutationOptions: () => {
            return { mutationFn: async () => undefined };
        },
    };
    // Any depth of namespace (`crpc.a.b.fn`) ends at `leaf`.
    const namespace: object = new Proxy({}, { get: (_target, key) => (Object.hasOwn(leaf, key) ? leaf[key as keyof typeof leaf] : namespace) });

    return { useCRPC: () => namespace };
});

vi.mock("@/features/chat/goal/use-thread-goal", () => {
    return { useThreadGoal: () => harness.goal };
});

vi.mock("@/features/evals/components/save-eval-case-action", () => {
    return { default: () => null };
});

vi.mock("./generation-model-menu", () => {
    return { default: () => null };
});

vi.mock("./read-aloud-action", () => {
    return { default: () => null };
});

vi.mock("./restore-to-input-action", () => {
    return { default: () => null };
});

vi.mock("./memory-usage-action", () => {
    return { default: () => null };
});

vi.mock("@/features/chat/translation/message-translation", () => {
    return { default: () => null };
});

vi.mock("@/features/chat/translation/translate-action", () => {
    return { default: () => null };
});

vi.mock("./fork-branch-dialog", () => {
    return { default: () => null };
});

// Imported after the mocks.
const { default: MessageList } = await import("./message-list");

const THREAD_LENGTH = 200;

const makeMessage = (index: number, text = `message ${index}`): UIMessage => {
    const role = index % 2 === 0 ? "user" : "assistant";

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

/** What a live query push looks like: a freshly decoded copy of the whole page. */
const decodeFresh = (messages: UIMessage[]): UIMessage[] => structuredClone(messages);

const Host = (): ReactNode => {
    const [value, setValue] = useState({ actions: harness.actions, messages: harness.messages });
    const ActionsContext = harness.ActionsContext!;
    const MessagesContext = harness.MessagesContext!;

    useLayoutEffect(() => {
        harness.publish = () => setValue({ actions: harness.actions, messages: harness.messages });
    }, []);

    return (
        <MessagesContext value={value.messages}>
            <ActionsContext value={value.actions}>
                <MessageList />
            </ActionsContext>
        </MessagesContext>
    );
};

const mountInto = () => {
    const queryClient = new QueryClient();

    return render(
        <QueryClientProvider client={queryClient}>
            <Host />
        </QueryClientProvider>,
    );
};

const mount = () => {
    mountInto();
};

/** Pushes a live update whose only change is the last message's text; returns the rows it re-rendered. */
const pushLastMessageEdit = (share: boolean, freshActions: boolean): number => {
    const previous = harness.messages as UIMessage[];
    const decoded = decodeFresh(previous);
    const lastIndex = decoded.length - 1;

    decoded[lastIndex] = makeMessage(lastIndex, `${previous[lastIndex]!.text} more`);

    harness.messages = share ? shareUnchangedMessages(previous, decoded) : decoded;

    if (freshActions) {
        harness.actions = { ...harness.actions };
    }

    harness.contentRenders.clear();
    act(() => harness.publish?.());

    let renders = 0;

    for (const count of harness.contentRenders.values()) {
        renders += count;
    }

    return renders;
};

// Each case mounts the whole thread from cold. On a slow Windows runner the first
// mount alone went past the 10 s default, with no change to what is measured.
const RENDER_TEST_TIMEOUT_MS = 60_000;

describe("message list render cost", () => {
    beforeEach(() => {
        harness.messages = Array.from({ length: THREAD_LENGTH }, (_, index) => makeMessage(index));
        harness.actions = { copyMessage: () => {}, reloadMessage: () => {} };
        harness.contentRenders.clear();
    });

    it(
        "re-renders every row when a push decodes fresh objects and the actions context changes (the old behaviour)",
        () => {
            mount();

            expect(pushLastMessageEdit(false, true)).toBeGreaterThanOrEqual(THREAD_LENGTH);
        },
        RENDER_TEST_TIMEOUT_MS,
    );

    it(
        "re-renders only the changed row once unchanged messages keep their identity and the actions context is stable",
        () => {
            mount();

            expect(pushLastMessageEdit(true, false)).toBe(1);
            expect(harness.contentRenders.get(`m${THREAD_LENGTH - 1}`)).toBe(1);
        },
        RENDER_TEST_TIMEOUT_MS,
    );

    it(
        "still re-renders every row when only the actions context changes",
        () => {
            mount();

            // Why chat-context reads `messages` through a ref in its action callbacks:
            // a new actions object alone re-renders all rows.
            expect(pushLastMessageEdit(true, true)).toBeGreaterThanOrEqual(THREAD_LENGTH);
        },
        RENDER_TEST_TIMEOUT_MS,
    );
});

/* eslint-disable testing-library/no-node-access, testing-library/no-container -- the assertion is about DOM ancestry */
describe("message list text size hook", () => {
    it("marks the message text with .message-text and keeps timestamps outside it", () => {
        harness.messages = Array.from({ length: 4 }, (_, index) => makeMessage(index));
        harness.actions = { copyMessage: () => {}, reloadMessage: () => {} };

        const { container } = mountInto();

        for (const index of [0, 1, 2, 3]) {
            expect(screen.getByText(`message ${index}`).closest(".message-text")).not.toBeNull();
        }

        const timestamps = container.querySelectorAll("time");

        expect(timestamps.length).toBeGreaterThan(0);

        for (const timestamp of timestamps) {
            expect(timestamp.closest(".message-text")).toBeNull();
        }
    });

    it("marks a system note as message text too", () => {
        harness.messages = [{ ...makeMessage(0, "system note"), role: "system" } as UIMessage];
        harness.actions = { copyMessage: () => {}, reloadMessage: () => {} };

        mountInto();

        expect(screen.getByText("system note").closest(".message-text")).not.toBeNull();
    });
});

describe("message list goal", () => {
    beforeEach(() => {
        harness.actions = {};
        harness.contentRenders.clear();
        harness.messages = [
            makeMessage(0, "Make the report"),
            makeMessage(1, "Here is a draft."),
            { ...makeMessage(2, `Goal: Ship the report.\n\n${formatGoalReviewNote("Add the charts.")}`), agentName: "neore:goal", order: 1 },
            { ...makeMessage(3, "Charts added."), order: 1 },
        ];
        harness.goal = {
            costMicrodollars: 0,
            createdAt: 1,
            goalId: "g1",
            maxCostMicrodollars: 2_000_000,
            maxRounds: 5,
            round: 2,
            startMessageId: "m0",
            status: "met",
            text: "Ship the report",
            verdicts: [
                { met: false, order: 0, reason: "Add the charts.", round: 1 },
                { met: true, order: 1, reason: "Charts added.", round: 2 },
            ],
        };
    });

    it("shows the goal at the top of the run and a verdict under each reply it judged", () => {
        mount();

        expect(screen.getByRole("region", { name: "Goal" }).textContent).toContain("Ship the report");
        expect(screen.getByText("Goal met: Charts added.")).toBeTruthy();
    });

    it("shows what the instruction that opened the second round carried as a review note, once", () => {
        mount();

        expect(screen.getAllByText("Review: Add the charts.")).toHaveLength(1);
        expect(screen.queryByText("Round 1: not yet. Add the charts.")).toBeNull();
    });

    it("does not show the instruction the goal saved to open its second round as a message", () => {
        mount();

        expect(harness.contentRenders.has("m2")).toBe(false);
        expect(harness.contentRenders.has("m1")).toBe(true);
        expect(harness.contentRenders.has("m3")).toBe(true);
    });
});
