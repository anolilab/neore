import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ModelFilterRules } from "./use-model-filter-rules";

// What the backend holds for the user's rules; the fake saves whatever the mutation sends, or refuses while `failSaves` is set.
const server = vi.hoisted(() => {
    return { failSaves: false, noRow: false, rules: undefined as ModelFilterRules | undefined };
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
                                    queryFn: async () => (server.noRow ? null : { modelFilterRules: server.rules }),
                                    queryKey: ["aiUserPreferences"],
                                };
                            },
                        },
                        updateAIUserPreferences: {
                            mutationOptions: () => {
                                return {
                                    mutationFn: async (input: { modelFilterRules: ModelFilterRules }) => {
                                        if (server.failSaves) {
                                            throw new Error("save refused");
                                        }

                                        server.rules = input.modelFilterRules;
                                        server.noRow = false;

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

const { useBlockedCreators, useUpdateModelFilterRules, withCreatorHidden, withoutCreator } = await import("./use-model-filter-rules");

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const wrapperFor =
    (queryClient: QueryClient) =>
    ({ children }: { children: React.ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children);

const mount = () => renderHook(() => useBlockedCreators(), { wrapper: wrapperFor(newClient()) });

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

describe(useUpdateModelFilterRules, () => {
    // The picker and the filters page are separate hook instances on one query cache.
    const mountBoth = async (queryClient: QueryClient) => {
        const { result: picker } = renderHook(() => useBlockedCreators(), { wrapper: wrapperFor(queryClient) });
        const { result: page } = renderHook(() => useUpdateModelFilterRules(), { wrapper: wrapperFor(queryClient) });

        await waitFor(() => {
            expect(page.current.isLoaded).toBe(true);
        });

        return { page, picker };
    };

    it("a filter edit made from an outdated snapshot keeps a lab hidden a moment earlier", async () => {
        server.rules = { requireZDR: true };

        const { page, picker } = await mountBoth(newClient());
        // Both edits hold the functions from before the other one ran: their renders are stale.
        const stalePicker = picker.current.setBlockedCreators;
        const stalePage = page.current.updateRules;

        await act(async () => {
            await stalePicker((current) => withCreatorHidden(current, "meta"));
        });
        await act(async () => {
            await stalePage((current) => {
                return { ...current, blockedRegions: ["EU"] };
            });
        });

        expect(server.rules).toEqual({ blockedCreators: ["meta"], blockedRegions: ["EU"], requireZDR: true });
    });

    it("a hide made from an outdated snapshot keeps a filter saved a moment earlier", async () => {
        server.rules = { requireZDR: true };

        const { page, picker } = await mountBoth(newClient());
        const stalePicker = picker.current.setBlockedCreators;
        const stalePage = page.current.updateRules;

        await act(async () => {
            await stalePage((current) => {
                return { ...current, blockedRegions: ["EU"] };
            });
        });
        await act(async () => {
            await stalePicker((current) => withCreatorHidden(current, "meta"));
        });

        expect(server.rules).toEqual({ blockedCreators: ["meta"], blockedRegions: ["EU"], requireZDR: true });
    });

    it("a refused save puts back the rules it replaced", async () => {
        server.rules = { requireZDR: true };

        const { page } = await mountBoth(newClient());

        server.failSaves = true;

        try {
            await act(async () => {
                await expect(
                    page.current.updateRules((current) => {
                        return { ...current, blockedRegions: ["EU"] };
                    }),
                ).rejects.toThrow("save refused");
            });
        } finally {
            server.failSaves = false;
        }

        expect(page.current.rules).toEqual({ requireZDR: true });
        expect(server.rules).toEqual({ requireZDR: true });
    });

    it("two edits from a user with no preferences row both survive", async () => {
        server.noRow = true;
        server.rules = undefined;

        const { page } = await mountBoth(newClient());

        await act(async () => {
            await page.current.updateRules((current) => {
                return { ...current, blockedRegions: ["EU"] };
            });
        });
        await act(async () => {
            await page.current.updateRules((current) => {
                return { ...current, requireZDR: true };
            });
        });

        expect(server.rules).toEqual({ blockedRegions: ["EU"], requireZDR: true });
    });

    it("clearing the last rule saves an empty object, which the server stores", async () => {
        server.rules = { blockedRegions: ["EU"] };

        const { page } = await mountBoth(newClient());

        await act(async () => {
            await page.current.updateRules(() => {
                return {};
            });
        });

        expect(server.rules).toEqual({});
    });
});
