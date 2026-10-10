/**
 * useConnectorActions Hook
 *
 * Connect (start the OAuth flow) and disconnect. Both are backend ACTIONS:
 * starting a flow discovers the provider's OAuth metadata and may register a
 * client, and disconnecting revokes the grant at the provider.
 */
import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useCRPC, useLunoraActionOptions } from "@/lib/lunora/crpc";

const useConnectorActions = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();

    const startMutation = useMutation(useLunoraActionOptions(api.connectors.oauth.startConnectorOAuth));
    const disconnectMutation = useMutation(useLunoraActionOptions(api.connectors.user_connectors.disconnectConnector));

    const initiateOAuth = async (connectorSlug: string) => {
        try {
            const { url } = await startMutation.mutateAsync({ connectorSlug });

            // Full navigation: the provider's consent screen, which returns to
            // /dashboard/settings/connectors/callback.
            globalThis.location.assign(url);
        } catch (error) {
            toast.error(error instanceof Error && error.message ? error.message : t`Failed to start the connection`);
        }
    };

    const disconnect = async (connectorId: string) => {
        try {
            const { revoked } = await disconnectMutation.mutateAsync({ connectorId: connectorId as Id<"userConnectors"> });

            await queryClient.invalidateQueries({ queryKey: crpc.connectors.user_connectors.listConnectorCatalog.queryKey({}) });

            if (revoked) {
                toast.success(t`Connector disconnected and access revoked`);
            } else {
                toast.success(t`Connector disconnected. Revoke access in the provider's settings if it is still listed there.`);
            }
        } catch (error) {
            toast.error(error instanceof Error && error.message ? error.message : t`Failed to disconnect connector`);
        }
    };

    return {
        disconnect,
        initiateOAuth,
        isDisconnecting: disconnectMutation.isPending,
        isStarting: startMutation.isPending,
        startingSlug: startMutation.isPending ? startMutation.variables?.connectorSlug : undefined,
    };
};

export default useConnectorActions;
