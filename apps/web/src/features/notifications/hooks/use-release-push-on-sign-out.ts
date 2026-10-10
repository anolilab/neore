import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

import { releaseBrowserPush } from "../lib/web-push-client";

/**
 * Every sign-out path calls this BEFORE ending the session, so this browser
 * stops receiving the account's push notifications (see `releaseBrowserPush`).
 */
export const useReleasePushOnSignOut = (): (() => Promise<void>) => {
    const crpc = useCRPC();
    const { mutateAsync: unsubscribePush } = useMutation(crpc.notifications.push.unsubscribePush.mutationOptions());

    return useCallback(async () => await releaseBrowserPush(async (endpoint) => await unsubscribePush({ endpoint })), [unsubscribePush]);
};
