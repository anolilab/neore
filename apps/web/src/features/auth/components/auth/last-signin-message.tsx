"use client";

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import cn from "@neore/ui/utils/cn";
import { Clock, Mail, User, Users } from "lucide-react";
import type { FC } from "react";

import type { SignInMethod } from "@/features/auth/hooks/use-last-signin-method";
import useLastSignInMethod from "@/features/auth/hooks/use-last-signin-method";

interface LastSignInMessageProperties {
    className?: string;
    classNames?: {
        badge?: string;
        container?: string;
        icon?: string;
        text?: string;
    };
}

const MethodIcon = ({ className, method }: { className?: string; method: SignInMethod }) => {
    switch (method) {
        case "anonymous":
        case "username": {
            return <User className={className} />;
        }
        case "email": {
            return <Mail className={className} />;
        }
        case "social": {
            return <Users className={className} />;
        }
        default: {
            return <Clock className={className} />;
        }
    }
};

const getMethodLabel = (method: SignInMethod, t: ReturnType<typeof useLingui>["t"]) => {
    switch (method) {
        case "anonymous": {
            return t`Guest`;
        }
        case "email": {
            return t`Email`;
        }
        case "social": {
            return t`Social`;
        }
        case "username": {
            return t`Username`;
        }
        default: {
            return t`Unknown`;
        }
    }
};

const LastSignInMessage: FC<LastSignInMessageProperties> = ({ className, classNames }) => {
    const { isHydrated, lastSignIn } = useLastSignInMethod();
    const { t } = useLingui();

    if (!isHydrated || !lastSignIn) {
        return undefined;
    }

    // Don't show message for anonymous/guest sign-ins
    if (lastSignIn.method === "anonymous") {
        return undefined;
    }

    return (
        <div className={cn("flex items-center gap-2", className, classNames?.container)}>
            <div className={cn("text-muted-foreground text-xs", classNames?.text)}>
                {t`You signed in with`}
                <Badge className={cn("mx-2 text-xs", classNames?.badge)} variant="secondary">
                    {lastSignIn.email ? (
                        <span className="ml-1 font-medium">{lastSignIn.email}</span>
                    ) : (
                        <>
                            <MethodIcon className={cn("mr-1 h-3 w-3", classNames?.icon)} method={lastSignIn.method} />
                            {lastSignIn.socialProvider ?? getMethodLabel(lastSignIn.method, t)}
                        </>
                    )}
                </Badge>
                {t`the last time`}
            </div>
        </div>
    );
};

export default LastSignInMessage;
