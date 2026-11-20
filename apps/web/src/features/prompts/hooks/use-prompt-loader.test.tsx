import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";

import usePromptLoader from "./use-prompt-loader";

/** Saved prompts the query cache already holds, by id: a cache hit answers in the same render as the id change. */
const cached = vi.hoisted(() => new Map<string, { content: string; contentBy?: string; contentByImpersonator?: boolean; userId?: string }>());

/** The session read: pending until a test lets it load. */
const session = vi.hoisted(() => {
    return { data: null as { user: { id: string } } | null, isPending: false };
});

vi.mock("@tanstack/react-query", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("@tanstack/react-query")>()),
        useQuery: (options: { promptId?: string }) => {
            return { data: options.promptId === undefined ? undefined : cached.get(options.promptId) };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return { prompts: { functions: { getPrompt: { queryOptions: (args: unknown) => (typeof args === "object" ? args : {}) } } } };
        },
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray) => strings.join("") };
        },
    };
});

vi.mock("sonner", () => {
    return { toast: { error: vi.fn(), success: vi.fn() } };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                hooks: {
                    useActiveOrganization: () => {
                        return { data: null };
                    },
                    useSession: () => {
                        return { ...session };
                    },
                },
            };
        },
    };
});

// Variables are not under test, and their module's labels need the Lingui compiler.
vi.mock("../lib/prompt-variables", () => {
    return {
        getAutoPopulatedVariables: () => {
            return {};
        },
        replaceVariables: (content: string) => content,
    };
});

const catalog = vi.hoisted(() => {
    return { settled: true };
});

vi.mock("@/hooks/use-feature-flagged-models", () => {
    const models: unknown[] = [];

    // One array, as a memoized list is: a new one on each render would re-run the loader by itself.
    return { default: () => models, useFeatureFlaggedModelsSettled: () => catalog.settled };
});

beforeEach(() => {
    cached.clear();
    session.data = null;
    session.isPending = false;
    catalog.settled = true;
    useChatUIStore.getState().clearComposer();
});

describe(usePromptLoader, () => {
    it("loads a second saved prompt the cache already holds when the address switches to it", () => {
        cached.set("prompt-b", { content: "Second prompt" });

        const { rerender } = renderHook(({ promptId }: { promptId: string | undefined }) => usePromptLoader(promptId), {
            initialProps: { promptId: "prompt-a" as string | undefined },
        });

        // The first prompt arrives after the page has mounted, as one fetched rather than cached does.
        cached.set("prompt-a", { content: "First prompt" });
        rerender({ promptId: "prompt-a" });

        expect(useChatUIStore.getState().composerText).toBe("First prompt");

        rerender({ promptId: "prompt-b" });

        expect(useChatUIStore.getState().composerText).toBe("Second prompt");
    });

    it("loads a saved prompt again when the address leaves it and comes back", () => {
        cached.set("prompt-a", { content: "First prompt" });

        const { rerender } = renderHook(({ promptId }: { promptId: string | undefined }) => usePromptLoader(promptId), {
            initialProps: { promptId: "prompt-a" as string | undefined },
        });

        useChatUIStore.getState().clearComposer();
        rerender({ promptId: undefined });
        rerender({ promptId: "prompt-a" });

        expect(useChatUIStore.getState().composerText).toBe("First prompt");
    });

    it("waits for the model list before checking a saved prompt, so a list still loading does not refuse it", () => {
        cached.set("prompt-a", { content: "First prompt" });
        catalog.settled = false;

        const { rerender } = renderHook(({ promptId }: { promptId: string | undefined }) => usePromptLoader(promptId), {
            initialProps: { promptId: "prompt-a" as string | undefined },
        });

        expect(useChatUIStore.getState().composerText).toBe("");

        catalog.settled = true;
        rerender({ promptId: "prompt-a" });

        expect(useChatUIStore.getState().composerText).toBe("First prompt");
    });

    it("waits for the session before telling whose words a saved prompt holds, so the viewer's own is not marked", () => {
        cached.set("prompt-a", { content: "My own words", contentBy: "user-a", contentByImpersonator: false, userId: "user-a" });
        session.isPending = true;

        const { rerender } = renderHook(({ promptId }: { promptId: string | undefined }) => usePromptLoader(promptId), {
            initialProps: { promptId: "prompt-a" as string | undefined },
        });

        expect(useChatUIStore.getState().composerText).toBe("");

        session.data = { user: { id: "user-a" } };
        session.isPending = false;
        rerender({ promptId: "prompt-a" });

        expect(useChatUIStore.getState().composerText).toBe("My own words");
        expect(useChatUIStore.getState().composerDraftFrom).toBeUndefined();
    });

    it("marks a saved prompt when the session loads signed out", () => {
        cached.set("prompt-a", { content: "Some words", contentBy: "user-a", contentByImpersonator: false, userId: "user-a" });
        session.isPending = true;

        const { rerender } = renderHook(({ promptId }: { promptId: string | undefined }) => usePromptLoader(promptId), {
            initialProps: { promptId: "prompt-a" as string | undefined },
        });

        session.isPending = false;
        rerender({ promptId: "prompt-a" });

        expect(useChatUIStore.getState().composerText).toBe("Some words");
        expect(useChatUIStore.getState().composerDraftFrom).toBe("sharedPrompt");
    });
});
