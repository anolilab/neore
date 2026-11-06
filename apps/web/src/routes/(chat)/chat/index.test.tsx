/**
 * The chat index route, rendered for real: its search parser, its page and the prompt-link hook it runs. Only the router,
 * the auth and data boundaries and the assistant are stubbed, so a link is read the way the browser delivers it.
 */
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { MODEL_REGISTRY } from "@neore/ai/models";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import type { ModelId } from "@/features/chat/core/stores/model-store";
import { useModelStore } from "@/features/chat/core/stores/model-store";
import { buildPromptLink } from "@/features/chat/core/utils/prompt-link";
import { LANDING_MESSAGE_KEY } from "@/features/marketing/stores/landing-store";

import { Route } from "./index";

const harness = vi.hoisted(() => {
    return {
        assistantProps: undefined as { initialMessage?: string } | undefined,
        locationSearch: "",
        navigate: vi.fn(),
        search: {} as Record<string, unknown>,
        showWarning: vi.fn(),
    };
});

vi.mock("@tanstack/react-router", () => {
    return {
        createFileRoute: () => (options: Record<string, unknown>) => {
            return {
                options,
                useSearch: ({ select }: { select?: (search: Record<string, unknown>) => unknown } = {}) => (select ? select(harness.search) : harness.search),
            };
        },
        useLocation: () => {
            return { search: harness.locationSearch, state: { __TSR_key: "navigation-1" } };
        },
        useNavigate: () => harness.navigate,
        useRouteContext: () => {
            return { token: "jwt" };
        },
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("@/features/chat/assistant", () => {
    return {
        default: (props: { initialMessage?: string }) => {
            harness.assistantProps = props;

            return null;
        },
    };
});

vi.mock("@/components/error-boundaries/route-error-boundary", () => {
    return {
        default: ({ children }: { children: ReactNode }) => children,
    };
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
                    useActiveOrganization: () => {
                        return { data: undefined, isPending: false };
                    },
                    useSession: () => {
                        return { data: undefined, isPending: false };
                    },
                },
            };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                chat: {
                    resume: {
                        latestResumableThread: {
                            queryOptions: () => {
                                return { queryFn: () => null, queryKey: ["latest-resumable-thread"] };
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
        showWarning: (message: unknown) => harness.showWarning(message),
    };
});

const textModel = MODEL_REGISTRY.find((model) => (model.mode ?? "text") === "text" && model.enabled !== false && model.provider !== "external");

type ValidateSearch = (search: Record<string, unknown>) => Record<string, unknown>;

/** Opens `url` the way the router does: its query string goes through the route's own search parser. */
const openUrl = (url: string): void => {
    const { search } = new URL(url);
    const validate = Route.options.validateSearch as unknown as ValidateSearch;

    harness.locationSearch = search;
    harness.search = validate(Object.fromEntries(new URLSearchParams(search)));
};

/** A link built by the copy side, with `extra` parameters added to its address (a handoff flag, a saved prompt). */
const linkWith = (extra: Record<string, string>): string => {
    const link = new URL(buildPromptLink("https://app.example.com", { model: textModel?.id, prompt: "from the link" }));

    for (const [key, value] of Object.entries(extra)) {
        link.searchParams.set(key, value);
    }

    return link.href;
};

const renderPage = (): void => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const ChatPage = Route.options.component as ComponentType;

    render(<ChatPage />, { wrapper: Wrapper });
};

const selectedModel = (): string => useModelStore.getState().selectedModel;

describe("chat index route", () => {
    beforeEach(() => {
        harness.assistantProps = undefined;
        harness.navigate.mockReset();
        harness.showWarning.mockReset();
        sessionStorage.clear();
        useChatUIStore.getState().setComposerText("");
        useChatUIStore.setState({ attachedReferences: [], composerAttachments: [] });
        useModelStore.setState({ selectedModel: DEFAULT_CHAT_MODEL as ModelId });
    });

    afterEach(() => {
        sessionStorage.clear();
        useChatUIStore.getState().setComposerText("");
    });

    describe("a landing handoff that holds a message", () => {
        it("keeps the handoff's draft, refuses the link with a notice and strips the link from the address", async () => {
            sessionStorage.setItem(LANDING_MESSAGE_KEY, "handoff text");
            openUrl(linkWith({ initialMessage: "true" }));

            renderPage();

            await waitFor(() => expect(harness.assistantProps?.initialMessage).toBe("handoff text"));
            expect(useChatUIStore.getState().composerText).toBe("");
            expect(harness.showWarning).toHaveBeenCalledWith("This chat already has a prompt. The prompt from the link was not added.");
            expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
            expect(harness.navigate).toHaveBeenCalledTimes(1);
        });
    });

    describe("a landing handoff URL with no message in storage", () => {
        it("applies the link's prompt and model, because the handoff owns no draft", async () => {
            openUrl(linkWith({ initialMessage: "true" }));

            renderPage();

            await waitFor(() => expect(useChatUIStore.getState().composerText).toBe("from the link"));
            expect(harness.assistantProps?.initialMessage).toBeUndefined();
            expect(harness.showWarning).not.toHaveBeenCalled();
            expect(selectedModel()).toBe(textModel?.id);
            expect(harness.navigate).toHaveBeenCalledTimes(1);
        });
    });

    describe("a saved prompt named in the same URL", () => {
        it("keeps the saved prompt's draft and refuses the link", async () => {
            openUrl(linkWith({ promptId: "saved-1" }));

            renderPage();

            await waitFor(() => expect(harness.navigate).toHaveBeenCalledTimes(1));
            expect(useChatUIStore.getState().composerText).toBe("");
            expect(harness.showWarning).toHaveBeenCalledWith("This chat already has a prompt. The prompt from the link was not added.");
            expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
        });
    });
});
