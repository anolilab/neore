import { useAuthSession } from "@/features/auth/hooks/use-auth-session";

export default function useIsAnonymous() {
    const sessionResult = useAuthSession();
    const { data: sessionData } = sessionResult;

    const user = sessionData?.user;
    const isAnonymous = user?.isAnonymous ?? false;

    return {
        isAnonymous,
        // A failed read is "unknown", not "signed out": callers must not show signed-out controls for it.
        isSessionUnknown: sessionResult.error != null,
        sessionData,
        user,
    };
}
