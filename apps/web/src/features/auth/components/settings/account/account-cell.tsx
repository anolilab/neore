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
import { clearThreadListCacheFor, releaseThreadListWrites } from "@/features/chat/thread-list/lib/thread-list-cache";

import { getLocalizedError } from "../../../lib/utilities";
import type { Refetch } from "../../../types/hook-integration-types";
import UserView from "../../user-view";

export interface AccountCellProperties {
    className?: string;
    classNames?: SettingsCardClassNames;
    deviceSession: { session: Session; user: User };
    /** Every device session in this browser; without it the revoked one is taken to be its account's only session. */
    deviceSessions?: { session: Session; user: User }[];

    refetch?: Refetch;
}

const AccountCell = ({ className, classNames, deviceSession, deviceSessions, refetch }: AccountCellProperties) => {
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
        let failed = false;
        // Another session of the same account stays signed in here, so its stored list is still in use.
        const accountStays = (deviceSessions ?? []).some((other) => other.user.id === deviceSession.user.id && other.session.id !== deviceSession.session.id);

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
            // Still signed in on this browser, so its list may be saved again once the stored copy is gone.
            failed = true;
        } finally {
            // Success or not, the account may be gone from the browser, so its stored chat titles go with it, unless
            // another session of it remains: that session keeps using (and refreshing) the list.
            if (!accountStays) {
                clearThreadListCacheFor(deviceSession.user.id);

                if (failed) {
                    releaseThreadListWrites(deviceSession.user.id);
                }
            }
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
