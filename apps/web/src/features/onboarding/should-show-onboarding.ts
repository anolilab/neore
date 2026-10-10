/**
 * Whether the onboarding tour may open.
 *
 * Guests skip it until they convert — it sells features a guest cannot keep.
 * It also waits for the session: `isAnonymous` reads `false` while the session
 * is still loading, which is how guests used to see the tour flash open (the
 * dialog mounts under `<Authenticated>`, which only means an RPC token exists).
 */
export const shouldShowOnboarding = ({
    onboardingCompleted,
    user,
}: {
    onboardingCompleted: boolean | undefined;
    user: { isAnonymous?: boolean | null } | null | undefined;
}): boolean => !onboardingCompleted && Boolean(user) && !user?.isAnonymous;
