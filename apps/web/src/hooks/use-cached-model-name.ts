import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";

import { GATEWAY_MODELS_QUERY_KEY } from "./gateway-models-key";
import type { GatewayModelsResponse } from "./use-gateway-models";

/**
 * A model's display name from the gateway catalog already in the cache, or `undefined` while it is not. It never fetches: a
 * list row asks for it, and a hundred rows must not each start the catalog request.
 *
 * It reads the cache rather than observing the query: an observer without a `queryFn` becomes the one an invalidation
 * refetches with, and that refetch fails.
 */
const useCachedModelName = (modelId: string | undefined): string | undefined => {
    const queryClient = useQueryClient();
    const subscribe = useCallback((onChange: () => void) => queryClient.getQueryCache().subscribe(onChange), [queryClient]);
    const catalog = useSyncExternalStore(subscribe, () => queryClient.getQueryData<GatewayModelsResponse>(GATEWAY_MODELS_QUERY_KEY));

    return modelId === undefined ? undefined : catalog?.data.find((model) => model.id === modelId)?.name;
};

export default useCachedModelName;
