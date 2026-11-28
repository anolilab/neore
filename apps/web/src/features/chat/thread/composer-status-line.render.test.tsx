// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { setPinOverride, useGoalComposer } from "@/features/chat/goal/goal-store";

import ComposerStatusLine from "./composer-status-line";

const THREAD_ID = "k57abcdefghjkmnpqrstvwxyz0123456";

const env = vi.hoisted(() => {
    return { cachedPin: undefined as { maxRounds: number; text: string } | undefined, impersonating: false, local: false };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});
vi.mock("@neore/client-runtime", () => {
    return { useUnlockProof: () => undefined };
});
vi.mock("@tanstack/react-query", () => {
    return {
        skipToken: Symbol("skipToken"),
        useQuery: () => {
            return { data: env.cachedPin };
        },
    };
});
vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                chat: {
                    goals: {
                        functions: {
                            getPinnedGoal: {
                                queryOptions: () => {
                                    return {};
                                },
                            },
                        },
                    },
                },
            };
        },
    };
});
vi.mock("@/features/chat/core/hooks/use-current-model", () => {
    return { default: () => "custom:ollama/llama" };
});
vi.mock("@/features/local-models/hooks/use-local-model-turn", () => {
    return { useLocalModelTarget: () => (env.local ? { baseUrl: "http://localhost:11434", modelId: "llama" } : undefined) };
});
vi.mock("@/features/admin/hooks/use-is-impersonating", () => {
    return { useImpersonating: () => env.impersonating };
});
vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatIsStreaming: () => {
            return { sseStreamState: undefined };
        },
        useChatThread: () => {
            return { threadId: THREAD_ID };
        },
    };
});
vi.mock("@/features/chat/core/utils/thread-id", () => {
    return { getValidThreadId: (id: string | undefined) => id };
});
vi.mock("./composer-model-selector", () => {
    return {
        useBotThread: () => {
            return { isBotThread: false };
        },
    };
});
vi.mock("./composer-permission-mode", () => {
    return { useShownPermissionMode: () => "supervised" };
});
vi.mock("./composer-research-depth", () => {
    return {
        useResearchDepthLabels: () => {
            return {};
        },
    };
});
vi.mock("./composer-search-mode", () => {
    return {
        useSearchModeInfo: () => {
            return { icon: () => null, label: "" };
        },
    };
});

const GOAL = "Goal: run until done";
const renderLine = () => render(<ComposerStatusLine researchDepth={"standard" as never} searchMode="chat" textMode />);

beforeEach(() => {
    env.cachedPin = undefined;
    env.impersonating = false;
    env.local = false;
    useGoalComposer.setState({ enabled: false });
    setPinOverride(THREAD_ID, undefined);
    useChatUIStore.setState({ composerAttachments: [], composerText: "" });
});

describe(ComposerStatusLine, () => {
    it("shows the goal chip for the chat's pinned goal, which the next send runs", () => {
        env.cachedPin = { maxRounds: 3, text: "Ship it" };
        renderLine();

        expect(screen.getByText(GOAL)).toBeTruthy();
    });

    it("follows this tab's pending pin before the cache catches up", () => {
        env.cachedPin = { maxRounds: 3, text: "Ship it" };
        setPinOverride(THREAD_ID, null);
        renderLine();

        expect(screen.queryByText(GOAL)).toBeNull();
    });

    it("shows no pinned goal to an admin acting as the owner, whose sends go without it", () => {
        env.cachedPin = { maxRounds: 3, text: "Ship it" };
        env.impersonating = true;
        renderLine();

        expect(screen.queryByText(GOAL)).toBeNull();
    });

    it("drops the goal chip for a draft of attachments with no text, which sends without a goal", () => {
        env.cachedPin = { maxRounds: 3, text: "Ship it" };
        useChatUIStore.setState({ composerAttachments: [{ id: "a1" } as never], composerText: " " });
        renderLine();

        expect(screen.queryByText(GOAL)).toBeNull();
    });

    it("keeps the goal chip once text is typed beside the attachments", () => {
        env.cachedPin = { maxRounds: 3, text: "Ship it" };
        useChatUIStore.setState({ composerAttachments: [{ id: "a1" } as never], composerText: "Draft the brief" });
        renderLine();

        expect(screen.getByText(GOAL)).toBeTruthy();
    });

    it("shows no goal for a local model, which runs one plain turn", () => {
        env.cachedPin = { maxRounds: 3, text: "Ship it" };
        env.local = true;
        renderLine();

        expect(screen.queryByText(GOAL)).toBeNull();
    });

    it("renders nothing with no goal, pinned or armed", () => {
        const { container } = renderLine();

        expect(container.textContent).toBe("");
    });
});
