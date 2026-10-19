import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelFilterRules } from "./use-model-filter-rules";

// What the backend holds for the user's rules. A save whose rules `refuse` accepts is refused, as the backend would.
const server = vi.hoisted(() => {
    return {
        noRow: false,
        refuse: (_rules: ModelFilterRules): boolean => false,
        rules: undefined as ModelFilterRules | undefined,
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
                                    queryFn: async () => (server.noRow ? null : { modelFilterRules: server.rules }),
                                    queryKey: ["aiUserPreferences"],
                                };
                            },
                        },
                        updateAIUserPreferences: {
                            mutationOptions: () => {
                                return {
                                    mutationFn: async (input: { modelFilterRules: ModelFilterRules }) => {
                                        if (server.refuse(input.modelFilterRules)) {
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

const PREFERENCES_KEY = ["aiUserPreferences"];

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const wrapperFor =
    (queryClient: QueryClient) =>
    ({ children }: { children: React.ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children);

const mount = () => renderHook(() => useBlockedCreators(), { wrapper: wrapperFor(newClient()) });

afterEach(() => {
    server.refuse = () => false;
});

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

    /** How an edit settled, read as soon as it is started so a rejection is never unobserved. */
    const settle = async (edit: Promise<unknown>): Promise<string> => {
        try {
            await edit;

            return "saved";
        } catch (error) {
            return (error as Error).message;
        }
    };

    const blockRegions = (current: ModelFilterRules, regions: string[]): ModelFilterRules => {
        return { ...current, blockedRegions: regions };
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
            await stalePage((current) => blockRegions(current, ["EU"]));
        });

        expect(server.rules).toEqual({ blockedCreators: ["meta"], blockedRegions: ["EU"], requireZDR: true });
    });

    it("a hide made from an outdated snapshot keeps a filter saved a moment earlier", async () => {
        server.rules = { requireZDR: true };

        const { page, picker } = await mountBoth(newClient());
        const stalePicker = picker.current.setBlockedCreators;
        const stalePage = page.current.updateRules;

        await act(async () => {
            await stalePage((current) => blockRegions(current, ["EU"]));
        });
        await act(async () => {
            await stalePicker((current) => withCreatorHidden(current, "meta"));
        });

        expect(server.rules).toEqual({ blockedCreators: ["meta"], blockedRegions: ["EU"], requireZDR: true });
    });

    it("a refused save puts the cache back to the rules it replaced", async () => {
        server.rules = { requireZDR: true };
        server.refuse = () => true;

        const queryClient = newClient();
        const { page } = await mountBoth(queryClient);

        await act(async () => {
            await expect(page.current.updateRules((current) => blockRegions(current, ["EU"]))).rejects.toThrow("save refused");
        });

        expect(queryClient.getQueryData(PREFERENCES_KEY)).toEqual({ modelFilterRules: { requireZDR: true } });
        await waitFor(() => {
            expect(page.current.rules).toEqual({ requireZDR: true });
        });
        expect(server.rules).toEqual({ requireZDR: true });
    });

    it("with two edits pending, a refused first one leaves only the second's effect", async () => {
        server.rules = { requireZDR: true };
        server.refuse = (rules) => rules.blockedRegions?.join(",") === "EU";

        const queryClient = newClient();
        const { page } = await mountBoth(queryClient);
        let first!: Promise<unknown>;
        let second!: Promise<unknown>;

        act(() => {
            first = page.current.updateRules((current) => blockRegions(current, ["EU"]));
            second = page.current.updateRules((current) => {
                return { ...current, blockedProviders: ["groq"] };
            });
        });
        const outcomes = Promise.all([settle(first), settle(second)]);

        await act(async () => {
            expect(await outcomes).toStrictEqual(["save refused", "saved"]);
        });

        const expected = { blockedProviders: ["groq"], requireZDR: true };

        expect(queryClient.getQueryData(PREFERENCES_KEY)).toEqual({ modelFilterRules: expected });
        expect(server.rules).toEqual(expected);
    });

    it("with two edits pending and both refused, the cache is back to the original rules", async () => {
        server.rules = { requireZDR: true };
        server.refuse = () => true;

        const queryClient = newClient();
        const { page } = await mountBoth(queryClient);
        let first!: Promise<unknown>;
        let second!: Promise<unknown>;

        act(() => {
            first = page.current.updateRules((current) => blockRegions(current, ["EU"]));
            second = page.current.updateRules((current) => {
                return { ...current, blockedProviders: ["groq"] };
            });
        });
        const outcomes = Promise.all([settle(first), settle(second)]);

        await act(async () => {
            expect(await outcomes).toStrictEqual(["save refused", "save refused"]);
        });

        expect(queryClient.getQueryData(PREFERENCES_KEY)).toEqual({ modelFilterRules: { requireZDR: true } });
        expect(server.rules).toEqual({ requireZDR: true });
    });

    it("with two edits pending, a saved first one and a refused second leave only the first", async () => {
        server.rules = { requireZDR: true };
        server.refuse = (rules) => rules.blockedProviders?.includes("groq") === true;

        const queryClient = newClient();
        const { page } = await mountBoth(queryClient);
        let first!: Promise<unknown>;
        let second!: Promise<unknown>;

        act(() => {
            first = page.current.updateRules((current) => blockRegions(current, ["EU"]));
            second = page.current.updateRules((current) => {
                return { ...current, blockedProviders: ["groq"] };
            });
        });
        const outcomes = Promise.all([settle(first), settle(second)]);

        await act(async () => {
            expect(await outcomes).toStrictEqual(["saved", "save refused"]);
        });

        const expected = { blockedRegions: ["EU"], requireZDR: true };

        expect(queryClient.getQueryData(PREFERENCES_KEY)).toEqual({ modelFilterRules: expected });
        expect(server.rules).toEqual(expected);
    });

    it("a refused earlier edit does not undo a later one that saves", async () => {
        server.rules = { requireZDR: true };
        server.refuse = (rules) => rules.blockedRegions?.join(",") === "EU";

        const queryClient = newClient();
        const { page } = await mountBoth(queryClient);

        await act(async () => {
            await expect(page.current.updateRules((current) => blockRegions(current, ["EU"]))).rejects.toThrow("save refused");
            await page.current.updateRules((current) => blockRegions(current, ["EU", "US"]));
        });

        const newer = { blockedRegions: ["EU", "US"], requireZDR: true };

        expect(queryClient.getQueryData(PREFERENCES_KEY)).toEqual({ modelFilterRules: newer });
        expect(server.rules).toEqual(newer);
    });

    it("the first edit from a user with no preferences row is saved and shown", async () => {
        server.noRow = true;
        server.rules = undefined;

        const queryClient = newClient();
        const { page } = await mountBoth(queryClient);

        await act(async () => {
            await page.current.updateRules((current) => blockRegions(current, ["EU"]));
        });

        expect(server.rules).toEqual({ blockedRegions: ["EU"] });
        expect(queryClient.getQueryData(PREFERENCES_KEY)).toEqual({ modelFilterRules: { blockedRegions: ["EU"] } });
    });

    it("two edits from a user with no preferences row both survive", async () => {
        server.noRow = true;
        server.rules = undefined;

        const { page } = await mountBoth(newClient());

        await act(async () => {
            await page.current.updateRules((current) => blockRegions(current, ["EU"]));
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
