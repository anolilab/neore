"use client";

import { useLingui } from "@lingui/react/macro";
import { Avatar, AvatarFallback, AvatarImage } from "@neore/ui/components/avatar";
import { Skeleton } from "@neore/ui/components/skeleton";
import cn from "@neore/ui/utils/cn";

import type { Profile } from "@/features/auth/types/data-structure-types";
import { useUserPreferences } from "@/features/layout/hooks/use-ui-state";

import AnonymousUserIndicator from "./anonymous/anonymous-user-indicator";

export interface UserViewProperties {
    className?: string;
    isPending?: boolean;
    size?: "sm" | "default" | "lg" | null;
    user?: Profile | null;
}

/**
 * Displays user information with avatar and details in a compact view
 *
 * Renders a user's profile information with appropriate fallbacks:
 * - Shows avatar alongside user name and email when available
 * - Shows loading skeletons when isPending is true
 * - Falls back to generic "User" text when neither name nor email is available
 * - Blurs avatar and hides name/email when hidePersonalInfo is enabled.
 */
const UserView = ({ className, isPending, size, user }: UserViewProperties) => {
    const { t } = useLingui();
    const { hidePersonalInfo } = useUserPreferences();

    const getUserDisplayName = () => {
        if (hidePersonalInfo) {
            return t`User`;
        }

        return user?.displayUsername || user?.username || user?.displayName || user?.firstName || user?.name || user?.fullName || user?.email || t`User`;
    };

    return (
        <div className={cn("flex items-center gap-2", className)}>
            <Avatar className={cn("h-8 w-8", hidePersonalInfo && "blur-sm")}>
                {user?.image && <AvatarImage alt={user?.name || t`User`} src={user.image} />}
                <AvatarFallback name={user?.name || user?.email || undefined} />
            </Avatar>
            <div className={cn("grid flex-1 text-left leading-tight")}>
                {isPending ? (
                    <>
                        <Skeleton className={cn("max-w-full", size === "lg" ? "h-4.5 w-32" : "h-3.5 w-24")} />
                        {size !== "sm" && <Skeleton className={cn("mt-1.5 max-w-full", size === "lg" ? "h-3.5 w-40" : "h-3 w-32")} />}
                    </>
                ) : (
                    <>
                        <span className={cn("truncate font-semibold", size === "lg" ? "text-base" : "text-sm")}>{getUserDisplayName()}</span>
                        {!hidePersonalInfo && !user?.isAnonymous && size !== "sm" && (user?.name || user?.username) && (
                            <span className={cn("truncate opacity-70", size === "lg" ? "text-sm" : "text-xs")}>{user?.email}</span>
                        )}
                        {user?.isAnonymous && size !== "sm" && <AnonymousUserIndicator size="sm" />}
                    </>
                )}
            </div>
        </div>
    );
};

export default UserView;
