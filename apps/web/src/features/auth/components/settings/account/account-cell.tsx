"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Card } from "@neore/ui/components/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import cn from "@neore/ui/utils/cn";
import type { Session, User } from "better-auth";
import { EllipsisIcon, Loader2, LogOutIcon, RepeatIcon } from "lucide-react";
import { useState } from "react";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import { useSession } from "@/features/auth/hooks/session-user-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import { getLocalizedError } from "../../../lib/utilities";
import type { Refetch } from "../../../types/hook-integration-types";
import UserView from "../../user-view";

export interface AccountCellProperties {
    className?: string;
    classNames?: SettingsCardClassNames;
    deviceSession: { session: Session; user: User };

    refetch?: Refetch;
}

const AccountCell = ({ className, classNames, deviceSession, refetch }: AccountCellProperties) => {
    const {
        authClient,
        basePath,
        mutators: { revokeDeviceSession, setActiveSession },
        navigate,
        toast,
        viewPaths,
    } = useAuth();
    const { t } = useLingui();

    const { data: sessionData } = useSession(authClient);
    const [isLoading, setIsLoading] = useState(false);

    const handleRevoke = async () => {
        setIsLoading(true);

        try {
            await revokeDeviceSession({
                sessionToken: deviceSession.session.token,
            });
            refetch?.();
        } catch (error) {
            setIsLoading(false);

            toast({
                message: getLocalizedError({ error, t }),
                variant: "error",
            });
        }
    };

    const handleSetActiveSession = async () => {
        setIsLoading(true);

        try {
            await setActiveSession({
                sessionToken: deviceSession.session.token,
            });
            refetch?.();
        } catch (error) {
            setIsLoading(false);

            toast({
                message: getLocalizedError({ error, t }),
                variant: "error",
            });
        }
    };

    const isCurrentSession = deviceSession.session.id === sessionData?.session.id;

    return (
        <Card className={cn("flex-row p-4", className, classNames?.cell)}>
            <UserView user={deviceSession.user} />

            <DropdownMenu>
                <DropdownMenuTrigger
                    render={
                        <Button
                            className={cn("relative ms-auto", classNames?.button, classNames?.outlineButton)}
                            disabled={isLoading}
                            size="icon"
                            type="button"
                            variant="outline"
                        >
                            {isLoading ? <Loader2 className="animate-spin" /> : <EllipsisIcon className={classNames?.icon} />}
                        </Button>
                    }
                />

                <DropdownMenuContent>
                    {!isCurrentSession && (
                        <DropdownMenuItem onClick={handleSetActiveSession}>
                            <RepeatIcon className={classNames?.icon} />

                            {t`Switch Account`}
                        </DropdownMenuItem>
                    )}

                    <DropdownMenuItem
                        onClick={() => {
                            if (isCurrentSession) {
                                navigate(`${basePath}/${viewPaths.SIGN_OUT}`);

                                return;
                            }

                            handleRevoke();
                        }}
                    >
                        <LogOutIcon className={classNames?.icon} />

                        {isCurrentSession ? t`Sign Out` : t`Revoke`}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </Card>
    );
};

export default AccountCell;
