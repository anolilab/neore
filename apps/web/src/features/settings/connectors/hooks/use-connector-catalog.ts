/**
 * useConnectorCatalogForUser Hook
 *
 * Fetches the connector catalogue with the caller's own connections.
 */
import { useQuery } from "@tanstack/react-query";

import { useCRPC } from "@/lib/lunora/crpc";

/** Every connector with whether this deployment can connect it and the caller's own connection. */
export const useConnectorCatalogForUser = () => {
    const crpc = useCRPC();

    return useQuery(crpc.connectors.user_connectors.listConnectorCatalog.queryOptions({}));
};
