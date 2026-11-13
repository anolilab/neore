// @vitest-environment jsdom

/**
 * A refused `/v1/chat/media` kick-off (here the 403 daily limit) reaches the
 * chat error UI, as a refused `/v1/chat` does. `fetch` does not reject on a
 * 4xx, so before the helper the provider swallowed it and the reply sat on
 * "generating" with no explanation. A guest note's refusal is the exception: it goes back to the Guests tab, never to the
 * chat error UI, whose Retry would rerun the owner's last reply.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { useEffect } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ChatProvider, useChatActions, useChatError } from "./chat-context";

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

const server = setupServer();

beforeAll(() => {
    server.listen({ onUnhandledFrame: "error" });
});
afterEach(() => {
    server.resetHandlers();
});
afterAll(() => {
    server.close();
});

const holder: { send?: (text: string, attachments?: undefined, options?: { guestMessageId?: string }) => Promise<unknown> } = {};

const Probe = () => {
    const { sendMessage } = useChatActions();
    const { error } = useChatError();

    useEffect(() => {
        holder.send = sendMessage;
    }, [sendMessage]);

    return <p role="alert">{error?.message ?? ""}</p>;
};

const mediaStart = {
    contentType: "image",
    messageId: "m1",
    streamingConfig: { contentType: "image", model: "image-model" },
    threadId: "thread-1",
};

describe("media kick-off refusal", () => {
    it("shows the daily limit message when /v1/chat/media answers 403", async () => {
        server.use(
            http.post("https://gateway.test/v1/chat", () => HttpResponse.json(mediaStart)),
            http.post("https://gateway.test/v1/chat/media", () =>
                HttpResponse.json(
                    { error: "DAILY_MESSAGE_LIMIT_REACHED", message: "You've reached your daily message limit.", retryAfter: 3600 },
                    { status: 403 },
                ),
            ),
        );

        render(
            <QueryClientProvider client={new QueryClient()}>
                <ChatProvider jwtToken="token" model={"image-model" as never} threadId="thread-1">
                    <Probe />
                </ChatProvider>
            </QueryClientProvider>,
        );

        await act(async () => {
            await holder.send?.("draw a cat");
        });

        await waitFor(() => {
            expect(screen.getByRole("alert").textContent).toBe("You've reached your daily message limit.");
        });
    });
});

describe("guest note refusal", () => {
    it("never reaches the chat error UI, whose Retry reruns the owner's last reply, and comes back to the Guests tab", async () => {
        server.use(
            http.post("https://gateway.test/v1/chat", async ({ request }) => {
                const body = (await request.json()) as { guestMessageId?: string };

                return body.guestMessageId === undefined
                    ? HttpResponse.json({ error: "unavailable", message: "The service is unavailable." }, { status: 503 })
                    : HttpResponse.json({ error: "GUEST_NOTE_BEING_SENT", message: "That guest note is being sent." }, { status: 409 });
            }),
        );

        render(
            <QueryClientProvider client={new QueryClient()}>
                <ChatProvider jwtToken="token" model={"text-model" as never} threadId="thread-1">
                    <Probe />
                </ChatProvider>
            </QueryClientProvider>,
        );

        let outcome: unknown;

        await act(async () => {
            outcome = await holder.send?.("please call me back", undefined, { guestMessageId: "note-1" });
        });

        expect(outcome).toMatchObject({ failure: "That message is being sent.", started: false });
        // No error, so no banner and no Retry.
        expect(screen.getByRole("alert").textContent).toBe("");

        // The owner's own send still reports its failure there.
        await act(async () => {
            await holder.send?.("my own words");
        });

        await waitFor(() => expect(screen.getByRole("alert").textContent).not.toBe(""));
    });
});
