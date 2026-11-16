// @vitest-environment jsdom

/**
 * A pane of the split view is not the chat the model store describes: its provider must not load its chat into the store, only
 * the focused pane does, through the split view. Without the split view the same provider loads its chat, as before.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useModelStore } from "../stores/model-store";
import { ChatProvider } from "./chat-context";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});
vi.mock("@/lib/env", () => {
    return { default: { VITE_LLM_GATEWAY_URL: "https://gateway.test" } };
});
vi.mock("@tanstack/react-router", () => {
    return { useNavigate: () => vi.fn() };
});
vi.mock("@/lib/lunora/crpc", () => {
    const node = (): unknown =>
        new Proxy(() => {}, {
            apply: (_target, _this, args: unknown[]) =>
                args.length === 0 ? [] : { mutationFn: async () => {}, queryFn: async () => null, queryKey: ["crpc"] },
            get: (_target, key) =>
                ["mutationOptions", "queryKey", "queryOptions"].includes(String(key))
                    ? () => {
                          return { mutationFn: async () => {}, queryFn: async () => null, queryKey: ["crpc"] };
                      }
                    : node(),
        });

    return {
        useCRPC: () => node(),
        useLunora: () => {
            return { getAuthToken: () => "token" };
        },
    };
});
vi.mock("@neore/client-runtime", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("@neore/client-runtime")>()),
        registerStreamOfThread: vi.fn(),
        withUnlockProofBody: (body: unknown) => body,
    };
});
vi.mock("@/lib/analytics", () => {
    return { trackEvent: vi.fn() };
});
vi.mock("@/lib/native/bridge", () => {
    return { notifyNative: vi.fn(), shouldNotifyReplyFinished: () => false };
});
vi.mock("@/features/auth/hooks/use-user-settings", () => {
    return {
        useUserSettings: () => {
            return { data: undefined };
        },
    };
});
vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                hooks: {
                    useSession: () => {
                        return { data: { user: { id: "u1" } }, refetch: vi.fn() };
                    },
                },
            };
        },
    };
});
vi.mock("@/features/local-models/hooks/use-local-model-turn", () => {
    return {
        default: () => {
            return { cancel: vi.fn(), isStreaming: false, send: vi.fn(), streamingMessage: null, target: null };
        },
    };
});
vi.mock("../utils/language-utilities", () => {
    return { mapNavigatorLanguage: () => "en-US" };
});
vi.mock("../hooks/use-hydrated-messages", () => {
    return {
        default: () => {
            return { loadMore: vi.fn(), messages: [], status: "Exhausted" };
        },
    };
});

// The thread carries the model the store should take on when its chat loads.
const initialThread = { _id: "thread-1", mode: "text", model: "gpt-split-test" } as never;

const renderProvider = (splitPane: boolean) =>
    render(
        <QueryClientProvider client={new QueryClient()}>
            <ChatProvider initialThread={initialThread} jwtToken="token" splitPane={splitPane} threadId="thread-1">
                <span />
            </ChatProvider>
        </QueryClientProvider>,
    );

describe("ChatProvider in a split pane", () => {
    beforeEach(() => {
        useModelStore.setState({
            currentModeThreadId: undefined,
            selectedModel: "default-model",
            selectedModelThreadId: undefined,
        });
    });

    it("does not load its chat into the shared model store", () => {
        renderProvider(true);

        expect(useModelStore.getState().selectedModelThreadId).toBeUndefined();
        expect(useModelStore.getState().selectedModel).toBe("default-model");
    });

    it("loads its chat into the model store without the split view (control)", () => {
        renderProvider(false);

        expect(useModelStore.getState().selectedModelThreadId).toBe("thread-1");
        expect(useModelStore.getState().selectedModel).toBe("gpt-split-test");
    });
});
