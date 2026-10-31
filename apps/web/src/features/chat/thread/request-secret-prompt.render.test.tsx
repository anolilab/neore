// @vitest-environment jsdom

import type { ToolPart } from "@neore/chat-ui/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import RequestSecretPrompt from "./request-secret-prompt";

const SECRET = "sk-live-0123456789-supersecret";

const { answer, servers } = vi.hoisted(() => {
    return {
        answer: vi.fn(async (_variables: unknown) => {
            return { alreadyResolved: false, streamId: null };
        }),
        servers: { current: [] as { name: string; url: string }[] },
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray | string, ...values: unknown[]) => {
                    if (typeof strings === "string") {
                        return strings;
                    }

                    return strings.map((chunk, index) => `${chunk}${String(values[index] ?? "")}`).join("");
                },
            };
        },
    };
});
vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                hooks: {
                    useSession: () => {
                        return { data: { user: { id: "owner" } } };
                    },
                },
            };
        },
    };
});
vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatThread: () => {
            return { thread: { userId: "owner" }, threadId: "thread-1" };
        },
    };
});
vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                auth: {
                    functions: {
                        getAIUserPreferences: {
                            queryOptions: () => {
                                return {
                                    queryFn: async () => {
                                        return { mcpServers: servers.current };
                                    },
                                    queryKey: ["getAIUserPreferences"],
                                };
                            },
                        },
                    },
                },
                chat: {
                    request_secret: {
                        answerSecretRequest: {
                            mutationOptions: () => {
                                return { mutationFn: answer };
                            },
                        },
                    },
                },
            };
        },
    };
});
vi.mock("@/lib/toast", () => {
    return { showError: vi.fn() };
});

const SAVE = /^Save$/u;
const DECLINE = /Decline/u;
const FILES_HOST = /files\.example\.com/u;
const NO_SERVER = /no saved MCP server named Files/u;

const header = { header: "Authorization", kind: "mcp_header", server: "Files" } as const;

const part = (use: unknown): ToolPart =>
    ({ approval: { id: "approval-1" }, input: { label: "Files token", use }, state: "approval-requested", type: "tool-requestSecret" }) as unknown as ToolPart;

const mountCard = (use: unknown, children?: ReactNode) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
        <QueryClientProvider client={client}>
            <RequestSecretPrompt part={part(use)} />
            {children}
        </QueryClientProvider>,
    );

    return client;
};

describe("the secret request card", () => {
    it("keeps the value out of the mutation cache once the answer is sent", async () => {
        servers.current = [{ name: "Files", url: "https://files.example.com/mcp" }];

        const client = mountCard({ kind: "provider_key", provider: "openai" });
        const field = screen.getByPlaceholderText("Paste it here — it is not shown in the chat");

        fireEvent.change(field, { target: { value: SECRET } });
        fireEvent.click(screen.getByRole("button", { name: SAVE }));

        await waitFor(() => expect(answer).toHaveBeenCalledTimes(1));
        expect(answer.mock.calls[0]?.[0]).toMatchObject({ value: SECRET });

        // Settled and reset: the cache would otherwise keep the variables for gcTime (five minutes by default).
        await waitFor(() =>
            expect(
                JSON.stringify(
                    client
                        .getMutationCache()
                        .getAll()
                        .map((mutation) => mutation.state.variables),
                ),
            ).not.toContain(SECRET),
        );
    });

    it("names the host of the server a header will be set on", async () => {
        servers.current = [{ name: "Files", url: "https://files.example.com/mcp" }];
        mountCard(header);

        expect(await screen.findByText(FILES_HOST)).toBeTruthy();
        expect((screen.getByRole("button", { name: SAVE }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("cannot be saved when no saved server has that name, but can still be declined", async () => {
        servers.current = [{ name: "Other", url: "https://other.example.com/mcp" }];
        mountCard(header);

        expect(await screen.findByText(NO_SERVER)).toBeTruthy();

        fireEvent.change(screen.getByPlaceholderText("Paste it here — it is not shown in the chat"), { target: { value: SECRET } });

        expect((screen.getByRole("button", { name: SAVE }) as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByRole("button", { name: DECLINE }) as HTMLButtonElement).disabled).toBe(false);
    });
});
