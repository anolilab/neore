/**
 * Hooks for managing messenger platform connections.
 */
import { useMutation, useQuery } from "@tanstack/react-query";

import { trackEvent } from "@/lib/analytics";
import { useCRPC } from "@/lib/lunora/crpc";

/** List all messenger connections for the current user. */
export const useMessengerConnections = () => {
    const crpc = useCRPC();

    return useQuery(crpc.messenger.functions.getConnections.queryOptions({}));
};

/** Create a new messenger connection. */
export const useCreateMessengerConnection = () => {
    const crpc = useCRPC();

    return useMutation({
        ...crpc.messenger.functions.createConnection.mutationOptions(),
        onSuccess: (_data, variables) => {
            // `platform` is generated as `unknown` (the backend validator is a literal union), so narrow it.
            trackEvent("messenger_connected", { platform: typeof variables.platform === "string" ? variables.platform : "unknown" });
        },
    });
};

/** Issue a fresh pairing code (unpairs the current contact); the code is returned once. */
export const useRegeneratePairingCode = () => {
    const crpc = useCRPC();

    return useMutation(crpc.messenger.functions.regeneratePairingCode.mutationOptions());
};

/** Update a messenger connection status. */
export const useUpdateMessengerConnectionStatus = () => {
    const crpc = useCRPC();

    return useMutation(crpc.messenger.functions.updateConnectionStatus.mutationOptions());
};

/** Turn tools on or off for a connection's replies, and pick the groups they may use. */
export const useUpdateMessengerReplyTools = () => {
    const crpc = useCRPC();

    return useMutation(crpc.messenger.functions.updateConnectionReplyTools.mutationOptions());
};

/** Delete a messenger connection. */
export const useDeleteMessengerConnection = () => {
    const crpc = useCRPC();

    return useMutation({
        ...crpc.messenger.functions.deleteConnection.mutationOptions(),
        onSuccess: () => {
            // Known analytics gap: `deleteConnection` only takes `{ connectionId }` — the platform is not
            // part of the mutation input, so this event has always reported "unknown". Resolving it
            // would mean looking the connection up in the cache before it is removed.
            trackEvent("messenger_disconnected", { platform: "unknown" });
        },
    });
};
