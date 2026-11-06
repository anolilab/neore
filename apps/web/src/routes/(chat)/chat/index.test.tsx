/**
 * The chat index route, rendered for real: its search parser, its page and the prompt-link hook it runs. Only the router,
 * the auth and data boundaries and the assistant are stubbed, so a link is read the way the browser delivers it.
 */
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { MODEL_REGISTRY } from "@neore/ai/models";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { defaultParseSearch } from "@tanstack/react-router";
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
        composerModels: [] as { id: string }[],
        sessionPending: false,
        latestThread: undefined as string | undefined,
        locationSearch: "",
        navigate: vi.fn(),
        search: {} as Record<string, unknown>,
        settings: undefined as { resumeLastChat?: boolean } | undefined,
        showWarning: vi.fn(),
    };
});

vi.mock("@tanstack/react-router", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@tanstack/react-router")>();

    return {
        ...actual,
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

// The picker's list for this user: by default every text model, so the link may select any of them; a test narrows it.
vi.mock("@/hooks/use-composer-models", () => {
    return {
        useComposerModelEntries: () => new Map(harness.composerModels.map((model) => [model.id, { id: model.id }])),
    };
});

vi.mock("@/hooks/use-gateway-models", () => {
    return {
        useGatewayModelsSettled: () => true,
    };
});

vi.mock("@/features/auth/hooks/use-user-settings", () => {
    return {
        useUserSettings: () => {
            return { data: harness.settings };
        },
    };
});

// The app reads this once at boot from the first URL; the tests open the route with a query, so they turn it on directly.
vi.mock("@/features/chat/core/utils/resume-boot", () => {
    return {
        BOOTED_ON_CHAT_INDEX: true,
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
                        return { data: undefined, isPending: harness.sessionPending };
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
                                return { queryFn: () => harness.latestThread ?? null, queryKey: ["latest-resumable-thread"] };
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
    harness.search = validate(defaultParseSearch(search));
};

/** A link built by the copy side, with `extra` parameters added to its address (a handoff flag, a saved prompt). */
const linkWith = (extra: Record<string, string>): string => {
    const link = new URL(buildPromptLink("https://app.example.com", { model: textModel?.id, prompt: "from the link" }));

    for (const [key, value] of Object.entries(extra)) {
        link.searchParams.set(key, value);
    }

    return link.href;
};

/** Renders the page; the returned function re-renders it on the search last set, as the router does after a navigation. */
const mountPage = (): (() => void) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const ChatPage = Route.options.component as ComponentType;
    const { rerender } = render(<ChatPage />, { wrapper: Wrapper });

    return () => {
        rerender(<ChatPage />);
    };
};

/** Sets the address the page sees, read through the route's own search parser, as a navigation would. */
const setSearch = (raw: Record<string, string>): void => {
    harness.search = (Route.options.validateSearch as unknown as ValidateSearch)(raw);
};

const selectedModel = (): string => useModelStore.getState().selectedModel;

describe("chat index route", () => {
    beforeEach(() => {
        harness.assistantProps = undefined;
        harness.latestThread = undefined;
        harness.sessionPending = false;
        harness.composerModels = MODEL_REGISTRY.filter(
            (model) => (model.mode ?? "text") === "text" && model.enabled !== false && model.provider !== "external",
        ).map((model) => {
            return { id: model.id };
        });
        harness.settings = undefined;
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

            mountPage();

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

            mountPage();

            await waitFor(() => expect(useChatUIStore.getState().composerText).toBe("from the link"));
            expect(harness.assistantProps?.initialMessage).toBeUndefined();
            expect(harness.showWarning).not.toHaveBeenCalled();
            expect(selectedModel()).toBe(textModel?.id);
            expect(harness.navigate).toHaveBeenCalledTimes(1);
        });
    });

    describe("a later link after a saved prompt", () => {
        it("applies the link once the saved prompt's address is gone", async () => {
            openUrl("https://app.example.com/chat?promptId=saved-1");

            const update = mountPage();

            setSearch({ prompt: "later link" });
            update();

            await waitFor(() => expect(useChatUIStore.getState().composerText).toBe("later link"));
            expect(harness.showWarning).not.toHaveBeenCalled();
        });
    });

    describe("a handoff that takes its message before the session answers", () => {
        it("still owns the draft when the link is decided, so the link is refused with its notice", async () => {
            sessionStorage.setItem(LANDING_MESSAGE_KEY, "handoff text");
            openUrl(linkWith({ initialMessage: "true" }));
            harness.sessionPending = true;

            const update = mountPage();

            // The handoff takes its message on mount, while the session is still pending.
            await waitFor(() => expect(harness.assistantProps?.initialMessage).toBe("handoff text"));

            harness.sessionPending = false;
            update();

            await waitFor(() => expect(harness.showWarning).toHaveBeenCalledWith("This chat already has a prompt. The prompt from the link was not added."));
            expect(useChatUIStore.getState().composerText).toBe("");
            expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
        });
    });

    describe("a later link after a handoff has taken its message", () => {
        it("applies the link, even while the address still names the handoff flag", async () => {
            sessionStorage.setItem(LANDING_MESSAGE_KEY, "handoff text");
            openUrl(linkWith({ initialMessage: "true" }));

            const update = mountPage();

            await waitFor(() => expect(harness.assistantProps?.initialMessage).toBe("handoff text"));
            // The handoff owned the draft, so the link was refused; the navigation that strips it leaves only the flag.
            expect(useChatUIStore.getState().composerText).toBe("");
            setSearch({ initialMessage: "true" });
            update();

            // A later link in this visit, with the flag still in the address: the handoff has taken its message, so it owns nothing.
            setSearch({ initialMessage: "true", prompt: "second link" });
            update();

            await waitFor(() => expect(useChatUIStore.getState().composerText).toBe("second link"));
            expect(harness.showWarning).toHaveBeenCalledTimes(1);
        });
    });

    describe("a saved prompt named in the same URL", () => {
        it("keeps the saved prompt's draft and refuses the link", async () => {
            openUrl(linkWith({ promptId: "saved-1" }));

            mountPage();

            await waitFor(() => expect(harness.navigate).toHaveBeenCalledTimes(1));
            expect(useChatUIStore.getState().composerText).toBe("");
            expect(harness.showWarning).toHaveBeenCalledWith("This chat already has a prompt. The prompt from the link was not added.");
            expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
        });
    });

    describe("a link with no usable prompt, with resume-last-chat on", () => {
        // The route decides once per page load whether to resume (a module-level flag), so each case loads a fresh route and stores.
        const loadFresh = async () => {
            vi.resetModules();

            const route = await import("./index");
            const chatUI = await import("@/features/chat/core/stores/chat-ui-store");
            const models = await import("@/features/chat/core/stores/model-store");

            return { chatUI: chatUI.useChatUIStore, models: models.useModelStore, Route: route.Route };
        };

        const resumes = (): boolean => harness.navigate.mock.calls.some((call) => (call[0] as { to?: string }).to === "/chat/$threadId");

        beforeEach(() => {
            harness.settings = { resumeLastChat: true };
            harness.latestThread = "thread-9";
        });

        it("a blank prompt with a model still resumes the last chat, and the chat keeps its model", async () => {
            const fresh = await loadFresh();
            const link = new URL(`https://app.example.com/chat?model=${encodeURIComponent(textModel?.id ?? "")}&prompt=%20%20%20`);

            harness.locationSearch = link.search;
            harness.search = (fresh.Route.options.validateSearch as unknown as ValidateSearch)(defaultParseSearch(link.search));

            const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
            const Page = fresh.Route.options.component as ComponentType;

            render(<Page />, { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });

            await waitFor(() => expect(resumes()).toBe(true));
            expect(fresh.models.getState().selectedModel).toBe(DEFAULT_CHAT_MODEL);
            expect(fresh.chatUI.getState().composerText).toBe("");
        });

        it("a model-only link still resumes the last chat, and the chat keeps its model", async () => {
            const fresh = await loadFresh();
            const link = new URL(`https://app.example.com/chat?model=${encodeURIComponent(textModel?.id ?? "")}`);

            harness.locationSearch = link.search;
            harness.search = (fresh.Route.options.validateSearch as unknown as ValidateSearch)(defaultParseSearch(link.search));

            const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
            const Page = fresh.Route.options.component as ComponentType;

            render(<Page />, { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });

            await waitFor(() => expect(resumes()).toBe(true));
            expect(fresh.models.getState().selectedModel).toBe(DEFAULT_CHAT_MODEL);
        });

        it("a link with a usable prompt does not resume: it opens a draft instead", async () => {
            const fresh = await loadFresh();
            const link = new URL(buildPromptLink("https://app.example.com", { model: textModel?.id, prompt: "from the link" }));

            harness.locationSearch = link.search;
            harness.search = (fresh.Route.options.validateSearch as unknown as ValidateSearch)(defaultParseSearch(link.search));

            const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
            const Page = fresh.Route.options.component as ComponentType;

            render(<Page />, { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });

            await waitFor(() => expect(fresh.chatUI.getState().composerText).toBe("from the link"));
            expect(resumes()).toBe(false);
        });
    });

    describe("a link that names a model the picker does not offer", () => {
        it("does not select the gated model: the chat keeps its model, the prompt is drafted, and the person is told", async () => {
            const gated = MODEL_REGISTRY.find(
                (model) => (model.mode ?? "text") === "text" && model.enabled !== false && model.provider !== "external" && model.id !== DEFAULT_CHAT_MODEL,
            );

            expect(gated).toBeDefined();
            harness.composerModels = [{ id: DEFAULT_CHAT_MODEL }];
            openUrl(buildPromptLink("https://app.example.com", { model: gated?.id, prompt: "from the link" }));

            mountPage();

            await waitFor(() => expect(useChatUIStore.getState().composerText).toBe("from the link"));
            expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
            expect(harness.showWarning).toHaveBeenCalledWith("This link's model is not available in this chat. The chat keeps its model.");
        });
    });

    describe("a copied link read from its own query string", () => {
        it.each(["42", "true", '{"a":1}'])("opens a copied message that reads as %s as that exact text, not blank", async (prompt) => {
            openUrl(buildPromptLink("https://app.example.com", { prompt }));

            mountPage();

            await waitFor(() => expect(useChatUIStore.getState().composerText).toBe(prompt));
        });

        it("opens the copied text, cleaned, as the draft on the copied model", async () => {
            const link = buildPromptLink("https://app.example.com", {
                model: textModel?.id,
                prompt: "  Summarise\u{E0041} this\nin two lines  ",
            });

            openUrl(link);
            mountPage();

            await waitFor(() => expect(useChatUIStore.getState().composerText).toBe("Summarise this\nin two lines"));
            expect(selectedModel()).toBe(textModel?.id);
            expect(harness.navigate).toHaveBeenCalledTimes(1);
        });

        it("a blank prompt does not change the chat's model, even with a model in the link", () => {
            openUrl(`https://app.example.com/chat?model=${encodeURIComponent(textModel?.id ?? "")}&prompt=%20%20%20`);

            mountPage();

            expect(useChatUIStore.getState().composerText).toBe("");
            expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
            expect(harness.showWarning).not.toHaveBeenCalled();
        });

        it("treats a blank prompt parameter as no link: nothing is drafted and no navigation strips it", () => {
            openUrl("https://app.example.com/chat?prompt=%20%20%20");

            mountPage();

            expect(useChatUIStore.getState().composerText).toBe("");
            expect(harness.navigate).not.toHaveBeenCalled();
        });
    });
});
