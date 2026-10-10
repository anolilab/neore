import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef } from "react";

import useOnSuccessTransition from "@/features/auth/hooks/use-success-transition";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

interface OneTapProperties {
    redirectTo?: string;
}

type AuthClientWithOneTap = {
    oneTap: (options: { fetchOptions: { onSuccess: () => Promise<void>; throw: boolean } }) => void;
};

const OneTap = ({ redirectTo }: OneTapProperties) => {
    const { authClient, toast } = useAuth();
    const { t } = useLingui();
    const oneTapFetched = useRef(false);

    const { onSuccess } = useOnSuccessTransition({ redirectTo });

    useEffect(() => {
        if (oneTapFetched.current) {
            return;
        }

        oneTapFetched.current = true;

        try {
            (authClient as unknown as AuthClientWithOneTap).oneTap({
                fetchOptions: {
                    onSuccess,
                    throw: true,
                },
            });
        } catch {
            toast({
                message: t`An error occurred during One Tap sign in`,
                variant: "error",
            });
        }
    }, [authClient, onSuccess, t, toast]);

    return null;
};

export default OneTap;
