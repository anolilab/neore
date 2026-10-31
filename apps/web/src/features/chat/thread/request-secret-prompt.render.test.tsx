// @vitest-environment jsdom

import type { ToolPart } from "@neore/chat-ui/types";
import { QueryClient, QueryClientProvider, skipToken } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import RequestSecretPrompt from "./request-secret-prompt";

const SECRET = "sk-live-0123456789-supersecret";

const { answer, preferencesRow, readPreferences, servers, thread } = vi.hoisted(() => {
    return {
        preferencesRow: { current: undefined as { mcpServers?: { name: string; url: string }[] } | null | undefined },
        readPreferences: vi.fn(),
        thread: { current: { userId: "owner" } },
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
            return { thread: thread.current, threadId: "thread-1" };
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
                            // A real cRPC `queryOptions` turns `skipToken` into a query that never runs.
                            queryOptions: (args: unknown) => {
                                return {
                                    queryFn:
                                        args === skipToken
                                            ? skipToken
                                            : async () => {
                                                  readPreferences();

                                                  return preferencesRow.current === undefined ? { mcpServers: servers.current } : preferencesRow.current;
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
const FILES_ADDRESS = /https:\/\/files\.example\.com\/mcp/u;
const FILES_ADDRESS_HTTP = /http:\/\/files\.example\.com\/mcp/u;
const HIDDEN_QUERY = /hidden/u;
const TOO_LONG = /up to 500 characters/u;
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
    beforeEach(() => {
        thread.current = { userId: "owner" };
        preferencesRow.current = undefined;
        readPreferences.mockClear();
        answer.mockClear();
    });

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

    it("names the address of the server a header will be set on, scheme and path included, and nothing from the query", async () => {
        // eslint-disable-next-line unicorn/prefer-https -- the card has to show the scheme of a server saved over plain http
        servers.current = [{ name: "Files", url: "http://files.example.com/mcp?token=hidden" }];
        mountCard(header);

        expect(await screen.findByText(FILES_ADDRESS_HTTP)).toBeTruthy();
        expect(screen.queryByText(HIDDEN_QUERY)).toBeNull();
        expect((screen.getByRole("button", { name: SAVE }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("shows the address of an https server and enables Save once a value is typed", async () => {
        servers.current = [{ name: "Files", url: "https://files.example.com/mcp" }];
        mountCard(header);

        expect(await screen.findByText(FILES_ADDRESS)).toBeTruthy();

        fireEvent.change(screen.getByPlaceholderText("Paste it here — it is not shown in the chat"), { target: { value: SECRET } });

        expect((screen.getByRole("button", { name: SAVE }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("tells a user whose preferences hold no servers at all that there is none, rather than staying silent", async () => {
        preferencesRow.current = null;
        mountCard(header);

        expect(await screen.findByText(NO_SERVER)).toBeTruthy();
        expect((screen.getByRole("button", { name: SAVE }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("refuses a provider key longer than the server takes before sending, keeping what was typed", async () => {
        mountCard({ kind: "provider_key", provider: "openai" });

        const field = screen.getByPlaceholderText("Paste it here — it is not shown in the chat") as HTMLInputElement;

        fireEvent.change(field, { target: { value: "k".repeat(501) } });

        expect(screen.getByText(TOO_LONG)).toBeTruthy();
        expect((screen.getByRole("button", { name: SAVE }) as HTMLButtonElement).disabled).toBe(true);
        expect(field.value).toHaveLength(501);

        fireEvent.submit(field);

        expect(answer).not.toHaveBeenCalled();
        expect(field.value).toHaveLength(501);
    });

    it("lets a header value run past a provider key's limit", async () => {
        servers.current = [{ name: "Files", url: "https://files.example.com/mcp" }];
        mountCard(header);

        await screen.findByText(FILES_ADDRESS);
        fireEvent.change(screen.getByPlaceholderText("Paste it here — it is not shown in the chat"), { target: { value: "t".repeat(2000) } });

        expect(screen.queryByText(TOO_LONG)).toBeNull();
        expect((screen.getByRole("button", { name: SAVE }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("cannot be saved when no saved server has that name, but can still be declined", async () => {
        servers.current = [{ name: "Other", url: "https://other.example.com/mcp" }];
        mountCard(header);

        expect(await screen.findByText(NO_SERVER)).toBeTruthy();

        fireEvent.change(screen.getByPlaceholderText("Paste it here — it is not shown in the chat"), { target: { value: SECRET } });

        expect((screen.getByRole("button", { name: SAVE }) as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByRole("button", { name: DECLINE }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("shows a viewer who is not the owner neither the owner's servers nor a missing-server line, and reads nothing", () => {
        thread.current = { userId: "someone-else" };
        servers.current = [{ name: "Other", url: "https://other.example.com/mcp" }];
        mountCard(header);

        expect(screen.getByText("Set as the Authorization header on your Files MCP server")).toBeTruthy();
        expect(screen.queryByText(NO_SERVER)).toBeNull();
        expect(screen.queryByPlaceholderText("Paste it here — it is not shown in the chat")).toBeNull();
        expect(readPreferences).not.toHaveBeenCalled();
    });
});
