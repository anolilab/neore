"use client";

/**
 * Keeps PostHog identity in sync with the Better Auth session.
 *
 * - Calls `posthog.identify()` when the user signs in
 * - Calls `posthog.group("organization", orgId)` when the org changes
 * - Calls `posthog.reset()` when the user signs out
 */
import { usePostHog } from "posthog-js/react";
import { useEffect, useRef } from "react";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";

const usePostHogIdentity = (): void => {
    const posthog = usePostHog();
    const { hooks } = useAuth();

    const { data: sessionData } = hooks.useSession();
    const user = sessionData?.user;
    const isAnonymous = user?.isAnonymous ?? true;

    const { data: orgData } = hooks.useActiveOrganization();
    const activeOrgId = orgData?.id;
    const activeOrgName = orgData?.name;

    const previousUserIdRef = useRef<string | null>(null);
    const previousOrgIdRef = useRef<string | null>(null);

    // Identify / reset user and set super properties
    useEffect(() => {
        if (!posthog) {
            return;
        }

        // Register is_anonymous as a super property so it's attached to every event
        posthog.register({ is_anonymous: isAnonymous });

        const userId = user?.id ?? null;
        const wasIdentified = previousUserIdRef.current;

        // User signed in (or anonymous → authenticated)
        if (userId && !isAnonymous && wasIdentified !== userId) {
            posthog.identify(userId, {
                email: user?.email,
                name: user?.name,
            });
        }

        // User signed out (was identified, now is not)
        if (wasIdentified && (!userId || isAnonymous)) {
            posthog.reset();
        }

        previousUserIdRef.current = isAnonymous ? null : userId;
    }, [posthog, user?.id, user?.email, user?.name, isAnonymous]);

    // Set organization group
    useEffect(() => {
        if (!posthog) {
            return;
        }

        if (activeOrgId && activeOrgId !== previousOrgIdRef.current) {
            posthog.group("organization", activeOrgId, {
                name: activeOrgName,
            });
        }

        previousOrgIdRef.current = activeOrgId ?? null;
    }, [posthog, activeOrgId, activeOrgName]);
};

export default usePostHogIdentity;
