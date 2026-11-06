// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChatThreadContext } from "@/features/chat/core/context/chat-context-hooks";
import type { ThreadData } from "@/features/chat/core/context/chat-context-types";

import ComparisonView from "./comparison-view";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});
vi.mock("@neore/backend/api", () => {
    return { api: { chat: { functions: { getThreadUIMessages: "getThreadUIMessages" } } } };
});
vi.mock("@neore/ui/components/ai-elements/provider-icon", () => {
    return { ProviderIcon: () => null };
});
vi.mock("@tanstack/react-query", () => {
    return {
        useQuery: () => {
            return { data: undefined };
        },
    };
});
vi.mock("@tanstack/react-router", () => {
    return {
        useNavigate: () => () => {},
    };
});
vi.mock("@/features/auth/hooks/use-user-settings", () => {
    return { useUserSettings: () => ({ data: undefined }) };
});
vi.mock("@/hooks/use-feature-flagged-models", () => {
    return { default: () => [] };
});
vi.mock("@/lib/agent", () => {
    return {
        useUIMessages: () => {
            return {
                results: [
                    { id: "user-1", role: "user", text: "the question" },
                    { id: "assistant-1", role: "assistant", text: "the answer" },
                ],
            };
        },
    };
});
vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return { chat: { streaming: { getActiveStreamForThread: { queryOptions: () => ({}) } } } };
        },
    };
});
vi.mock("./streaming-placeholder", () => {
    return { StreamingPlaceholder: () => null };
});
// Stands in for the column's message content: it shows the lock state the context hands the column.
vi.mock("./message-content", async () => {
    const { use } = await import("react");
    const { ChatThreadContext: Context } = await import("@/features/chat/core/context/chat-context-hooks");

    return {
        default: () => {
            const context = use(Context);

            return <div data-testid="column-lock">{context.thread?.lockedAt ? "locked" : "open"}</div>;
        },
    };
});

describe("comparison columns", () => {
    it("give a column its own thread's lock state, not its unlocked parent's", () => {
        const parent = { _id: "parent", model: "gpt-4o", multiChat: true, userId: "user-1" } as unknown as ThreadData;
        const child = { _id: "child", lockedAt: 1_700_000_000_000, model: "gpt-4o", userId: "user-1" } as unknown as ThreadData;

        render(
            <ChatThreadContext value={{ isNewThread: false, model: "gpt-4o", thread: parent, threadId: "parent" }}>
                <ComparisonView
                    branches={[{ activeStreamId: null, isLoading: false, messages: [], model: "gpt-4o", thread: child, threadId: "child" }]}
                />
            </ChatThreadContext>,
        );

        expect(screen.getByTestId("column-lock").textContent).toBe("locked");
    });
});
