import { useQuery } from "@tanstack/react-query";

import { GATEWAY_MODELS_QUERY_KEY } from "./gateway-models-key";
import type { GatewayModelsResponse } from "./use-gateway-models";

/**
 * A model's display name from the gateway catalog already in the cache, or `undefined` while it is not. It never fetches: a
 * list row asks for it, and a hundred rows must not each start the catalog request.
 */
const useCachedModelName = (modelId: string | undefined): string | undefined => {
    const { data } = useQuery({
        enabled: false,
        queryKey: GATEWAY_MODELS_QUERY_KEY,
        select: (response: GatewayModelsResponse) => (modelId === undefined ? undefined : response.data.find((model) => model.id === modelId)?.name),
    });

    return data;
};

export default useCachedModelName;
