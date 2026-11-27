import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { GATEWAY_MODELS_QUERY_KEY } from "./gateway-models-key";
import useCachedModelName from "./use-cached-model-name";
import type { GatewayModelsResponse } from "./use-gateway-models";

const catalog = (name: string) => ({ data: [{ id: "m1", name }], object: "list", version: "1" }) as unknown as GatewayModelsResponse;

const setup = () => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useCachedModelName("m1"), { wrapper });

    return { queryClient, result };
};

describe(useCachedModelName, () => {
    it("names the model once the catalog reaches the cache", () => {
        const { queryClient, result } = setup();

        expect(result.current).toBeUndefined();

        act(() => {
            queryClient.setQueryData(GATEWAY_MODELS_QUERY_KEY, catalog("Model One"));
        });

        expect(result.current).toBe("Model One");
    });

    it("does not read the catalog again for another query's events", () => {
        const { queryClient } = setup();
        const reads = vi.spyOn(queryClient, "getQueryData");

        act(() => {
            queryClient.setQueryData(["something-else"], { value: 1 });
            queryClient.setQueryData(["something-else"], { value: 2 });
        });

        expect(reads).not.toHaveBeenCalled();
    });
});
