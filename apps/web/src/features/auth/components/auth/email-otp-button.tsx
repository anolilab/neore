import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import cn from "@neore/ui/utils/cn";
import { LockIcon, MailIcon } from "lucide-react";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import type { AuthView } from "../../lib/auth-view-paths";
import type { AuthCardClassNames } from "./auth-card";

interface EmailOTPButtonProperties {
    classNames?: AuthCardClassNames;
    isSubmitting?: boolean;
    view: AuthView;
}

const EmailOTPButton = ({ classNames, isSubmitting, view }: EmailOTPButtonProperties) => {
    const { basePath, navigate, viewPaths } = useAuth();
    const { t } = useLingui();

    return (
        <Button
            className={cn("w-full", classNames?.form?.button, classNames?.form?.secondaryButton)}
            disabled={isSubmitting}
            onClick={() => {
                navigate(`${basePath}/${view === "EMAIL_OTP" ? viewPaths.SIGN_IN : viewPaths.EMAIL_OTP}${globalThis.location.search}`);
            }}
            type="button"
            variant="secondary"
        >
            {view === "EMAIL_OTP" ? <LockIcon className={classNames?.form?.icon} /> : <MailIcon className={classNames?.form?.icon} />}
            {view === "EMAIL_OTP" ? t`Sign in with password` : t`Sign in with email code`}
        </Button>
    );
};

export default EmailOTPButton;
