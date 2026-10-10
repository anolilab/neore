import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import cn from "@neore/ui/utils/cn";
import { FingerprintIcon } from "lucide-react";

import useOnSuccessTransition from "@/features/auth/hooks/use-success-transition";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { getLocalizedError } from "@/features/auth/lib/utilities";

import type { AuthCardClassNames } from "./auth-card";

interface PasskeyButtonProperties {
    classNames?: AuthCardClassNames;
    isSubmitting?: boolean;
    redirectTo?: string;
    setIsSubmitting?: (isSubmitting: boolean) => void;
}

type AuthClientWithPasskey = {
    signIn: {
        passkey: (options: { fetchOptions: { throw: boolean } }) => Promise<{ error?: unknown } | null>;
    };
};

const PasskeyButton = ({ classNames, isSubmitting, redirectTo, setIsSubmitting }: PasskeyButtonProperties) => {
    const { authClient, toast } = useAuth();
    const { t } = useLingui();

    const { onSuccess } = useOnSuccessTransition({ redirectTo });

    const signInPassKey = async () => {
        setIsSubmitting?.(true);

        try {
            const response = await (authClient as unknown as AuthClientWithPasskey).signIn.passkey({
                fetchOptions: { throw: true },
            });

            if (response?.error) {
                toast({
                    message: getLocalizedError({
                        error: response.error,
                        t,
                    }),
                    variant: "error",
                });

                setIsSubmitting?.(false);
            } else {
                onSuccess();
            }
        } catch (error) {
            toast({
                message: getLocalizedError({ error, t }),
                variant: "error",
            });

            setIsSubmitting?.(false);
        }
    };

    return (
        <Button
            className={cn("w-full", classNames?.form?.button, classNames?.form?.secondaryButton)}
            disabled={isSubmitting}
            formNoValidate
            name="passkey"
            onClick={signInPassKey}
            value="true"
            variant="secondary"
        >
            <FingerprintIcon />
            {t`Sign in with passkey`}
        </Button>
    );
};

export default PasskeyButton;
