import { useAuth } from "@/features/auth/lib/auth-ui-provider";

export default function useIsAnonymous() {
    const { hooks } = useAuth();
    const { data: sessionData } = hooks.useSession();

    const user = sessionData?.user;
    const isAnonymous = user?.isAnonymous ?? false;

    return {
        isAnonymous,
        sessionData,
        user,
    };
}
