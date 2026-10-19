import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ModelFilterRules } from "./use-model-filter-rules";

// What the backend holds for the user's rules; the fake saves whatever the mutation sends.
const server = vi.hoisted(() => {
    return { rules: undefined as ModelFilterRules | undefined };
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
                                        return { modelFilterRules: server.rules };
                                    },
                                    queryKey: ["aiUserPreferences"],
                                };
                            },
                        },
                        updateAIUserPreferences: {
                            mutationOptions: () => {
                                return {
                                    mutationFn: async (input: { modelFilterRules: ModelFilterRules }) => {
                                        server.rules = input.modelFilterRules;

                                        return {};
                                    },
                                };
                            },
                        },
                    },
                },
            };
        },
    };
});

const { useBlockedCreators, withCreatorHidden, withoutCreator } = await import("./use-model-filter-rules");

const mount = () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);

    return renderHook(() => useBlockedCreators(), { wrapper });
};

describe(useBlockedCreators, () => {
    it("undoing the first hide removes only its lab and keeps a later hide", async () => {
        server.rules = { blockedCreators: ["meta"], requireZDR: true };

        const { result } = mount();

        // The query has loaded once the saved list shows up in the hook.
        await waitFor(() => {
            expect(result.current.blockedCreators).toEqual(["meta"]);
        });

        // Two hides that overlap: neither waits for the other to save.
        await act(async () => {
            await Promise.all([
                result.current.setBlockedCreators((current) => withCreatorHidden(current, "openai")),
                result.current.setBlockedCreators((current) => withCreatorHidden(current, "anthropic")),
            ]);
        });

        expect(server.rules).toEqual({ blockedCreators: ["meta", "openai", "anthropic"], requireZDR: true });

        // Undo of the first hide.
        await act(async () => {
            await result.current.setBlockedCreators((current) => withoutCreator(current, "openai"));
        });

        expect(server.rules).toEqual({ blockedCreators: ["meta", "anthropic"], requireZDR: true });
    });

    it("refuses to save before the preferences have loaded, so other filters are not replaced", async () => {
        server.rules = { blockedProviders: ["groq"], requireZDR: true };

        const { result } = mount();

        // The first render has not received the query result yet.
        expect(result.current.isLoaded).toBe(false);
        await expect(result.current.setBlockedCreators((current) => withCreatorHidden(current, "meta"))).rejects.toThrow("have not loaded");
        expect(server.rules).toEqual({ blockedProviders: ["groq"], requireZDR: true });

        await waitFor(() => {
            expect(result.current.isLoaded).toBe(true);
        });

        await act(async () => {
            await result.current.setBlockedCreators((current) => withCreatorHidden(current, "meta"));
        });

        expect(server.rules).toEqual({ blockedCreators: ["meta"], blockedProviders: ["groq"], requireZDR: true });
    });

    it("hiding a lab that is already hidden does not repeat it", () => {
        expect(withCreatorHidden(["meta"], "meta")).toEqual(["meta"]);
        expect(withCreatorHidden(["meta"], "openai")).toEqual(["meta", "openai"]);
    });
});
