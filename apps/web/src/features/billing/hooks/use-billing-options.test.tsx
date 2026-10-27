/** `useBillingOptions`: yearly pricing is offered only when the backend says so explicitly. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    return { options: undefined as unknown, queryOptionsArguments: [] as unknown[][], shouldFail: false };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                billing: {
                    checkout: {
                        getBillingOptions: {
                            queryOptions: (...arguments_: unknown[]) => {
                                harness.queryOptionsArguments.push(arguments_);

                                return {
                                    queryFn: async () => {
                                        if (harness.shouldFail) {
                                            throw new Error("backend down");
                                        }

                                        return harness.options;
                                    },
                                    queryKey: ["billing-options"],
                                };
                            },
                        },
                    },
                },
            };
        },
    };
});

const { default: useBillingOptions } = await import("./use-billing-options");

const mount = () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    return renderHook(() => useBillingOptions(), {
        wrapper: ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children),
    });
};

describe("useBillingOptions", () => {
    it("offers no yearly plan before the options arrive", () => {
        harness.options = { yearly: { pro: true, team: true } };

        expect(mount().result.current.yearly).toStrictEqual({ pro: false, team: false });
    });

    it("reads which plans can be bought yearly", async () => {
        harness.options = { yearly: { pro: true, team: false } };
        const { result } = mount();

        await waitFor(() => {
            expect(result.current.yearly.pro).toBe(true);
        });

        expect(result.current.yearly.team).toBe(false);
    });

    it("keeps yearly off when the options call fails", async () => {
        harness.options = undefined;
        harness.shouldFail = true;
        const { result } = mount();

        await new Promise((resolve) => {
            setTimeout(resolve, 20);
        });

        expect(result.current.yearly).toStrictEqual({ pro: false, team: false });
        harness.shouldFail = false;
    });

    it("opts out of the live subscription, so settings never join first paint", () => {
        harness.queryOptionsArguments = [];
        harness.options = { yearly: { pro: false, team: false } };
        mount();

        expect(harness.queryOptionsArguments[0]).toStrictEqual([{}, { live: false }]);
    });
});
