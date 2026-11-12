"use client";

/**
 * Publishes the Better Auth session's identity for PostHog (`setAnalyticsIdentity`): who is signed in and their
 * active organization. `posthog-client.ts` applies it, `identify`, `group("organization", …)` and `reset()` on
 * sign-out, both when PostHog starts (before anything queued is sent) and on every later change.
 */
import { useEffect } from "react";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { setAnalyticsIdentity } from "@/lib/analytics/posthog-client";

const usePostHogIdentity = (): void => {
    const { hooks } = useAuth();

    const { data: sessionData, isPending: isSessionPending } = hooks.useSession();
    const user = sessionData?.user;
    const isSignedIn = Boolean(user && !user.isAnonymous);

    // Without a session this read is skipped and stays pending, so it is waited for only when there is one.
    const { data: orgData, isPending: isOrgPending } = hooks.useActiveOrganization();
    const isKnown = !isSessionPending && !(user && isOrgPending);

    const userId = isSignedIn ? user?.id : undefined;
    const email = user?.email;
    const name = user?.name;
    const orgId = orgData?.id;
    const orgName = orgData?.name;

    useEffect(() => {
        if (!isKnown) {
            return;
        }

        setAnalyticsIdentity({
            organization: orgId ? { id: orgId, name: orgName } : undefined,
            user: userId ? { email, id: userId, name } : undefined,
        });
    }, [isKnown, userId, email, name, orgId, orgName]);
};

export default usePostHogIdentity;
