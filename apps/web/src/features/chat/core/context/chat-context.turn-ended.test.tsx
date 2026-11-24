// @vitest-environment jsdom

/**
 * The provider tells the page when a turn of its thread ended (`turn-ended.ts`), from its own stream state: a control whose
 * read of the thread has not answered still hears it. Opening a thread, or one that never streamed, tells nothing.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { subscribeTurnEnded } from "../utils/turn-ended";
import { ChatProvider } from "./chat-context";

const { hydrated } = vi.hoisted(() => {
    return { hydrated: { messages: [] as { id: string; parts: unknown[]; role: string; status: string; text: string }[] } };
});

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
            return { loadMore: vi.fn(), messages: hydrated.messages, status: "Exhausted" };
        },
    };
});

const initialThread = { _id: "thread-1", mode: "text", model: "gpt-turn-test" } as never;

const prompt = { id: "m1", parts: [], role: "user", status: "success", text: "hi" };

const reply = (status: string) => {
    return { id: "m2", parts: [], role: "assistant", status, text: "hello" };
};

const view = () => (
    <QueryClientProvider client={new QueryClient()}>
        <ChatProvider initialThread={initialThread} jwtToken="token" threadId="thread-1">
            <span />
        </ChatProvider>
    </QueryClientProvider>
);

describe("ChatProvider's end of a turn", () => {
    beforeEach(() => {
        hydrated.messages = [];
    });

    it("tells the thread's listeners once when its reply stops streaming", () => {
        const ended = vi.fn();
        const other = vi.fn();
        const stop = subscribeTurnEnded("thread-1", ended);
        const stopOther = subscribeTurnEnded("thread-2", other);

        hydrated.messages = [prompt, reply("streaming")];

        const { rerender } = render(view());

        expect(ended).not.toHaveBeenCalled();

        hydrated.messages = [prompt, reply("success")];
        rerender(view());
        rerender(view());

        expect(ended).toHaveBeenCalledTimes(1);
        expect(other).not.toHaveBeenCalled();

        stop();
        stopOther();
    });

    it("tells nothing when the thread opens settled", () => {
        const ended = vi.fn();
        const stop = subscribeTurnEnded("thread-1", ended);

        hydrated.messages = [prompt, reply("success")];

        const { rerender } = render(view());

        rerender(view());

        expect(ended).not.toHaveBeenCalled();

        stop();
    });
});
