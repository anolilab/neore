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

    // Without a session this read is skipped and stays pending; only a signed-in user's organization is read at all, so
    // a cached one never follows a sign-out onto the anonymous client.
    const { data: orgData, isPending: isOrgPending } = hooks.useActiveOrganization();

    const userId = isSignedIn ? user?.id : undefined;
    const email = user?.email;
    const name = user?.name;
    // The user is published as soon as the session knows them; the organization follows when it answers.
    const isOrganizationPending = userId !== undefined && isOrgPending;
    const orgId = userId === undefined || isOrganizationPending ? undefined : orgData?.id;
    const orgName = orgData?.name;

    useEffect(() => {
        if (isSessionPending) {
            return;
        }

        setAnalyticsIdentity({
            isOrganizationPending,
            organization: orgId ? { id: orgId, name: orgName } : undefined,
            user: userId ? { email, id: userId, name } : undefined,
        });
    }, [isSessionPending, isOrganizationPending, userId, email, name, orgId, orgName]);
};

export default usePostHogIdentity;
